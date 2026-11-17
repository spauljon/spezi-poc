package com.aboutobjects.healthgate.ingest.healthconnect

import com.aboutobjects.healthgate.contract.MetricRegistry
import com.aboutobjects.healthgate.ingest.IngestItem
import com.aboutobjects.healthgate.mapping.MappingException
import com.aboutobjects.healthgate.mapping.QualityFlagger
import com.aboutobjects.healthgate.queue.ChangeSet
import com.aboutobjects.healthgate.queue.LedgerEntry
import com.aboutobjects.healthgate.queue.SampleQueue
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext

/** What one collection did, in counts only (never a value). */
data class CollectOutcome(
    val mode: Mode,
    val recordsUpserted: Int = 0,
    val recordsDeleted: Int = 0,
    /** Records the contract refuses as a whole (an empty id, an impossible value): left out, never a reason to stop. */
    val recordsRefused: Int = 0,
    val samplesQueued: Int = 0,
    /** The failure's class name when the run stopped early; the token did not advance past what was committed. */
    val failure: String? = null,
) {
    enum class Mode { WINDOW, CHANGES, BUSY }

    val succeeded: Boolean get() = failure == null
}

/**
 * Reads Health Connect into the queue without loss (M27). The rules:
 * - **Acknowledged hand-off.** The changes token is stored only after every sample of the page it covers is committed to the queue. A
 *   crash or failure in between repeats the page, which converges: identities and content make a repeat a no-op.
 * - **First run, or an expired token:** a fixed window of [Settings.windowDays] is read page by page; then every record the ledger holds
 *   from that window that was not seen is treated as deleted. The token is taken BEFORE the window is read, so nothing is missed.
 * - **A record changed:** its samples are queued (an edit is an update of the same identity); a sample the record no longer holds is
 *   deleted. **A record deleted:** all its samples are deleted (nothing is sent for one never uploaded).
 * - **Nutrition** is identified by content, not record id (MyFitnessPal re-creates its records on every sync): the group is
 *   `<content key>#<n>`, n the smallest ordinal not in use by another live record of that content, so twins never collide.
 * - **Bounded memory.** Records are read [Settings.pageSize] at a time and queued in chunks of [Settings.chunk] samples.
 */
class HealthConnectCollector(
    private val gateway: HealthConnectGateway,
    private val queue: SampleQueue,
    private val state: CollectorStateStore,
    registry: MetricRegistry,
    private val settings: Settings = Settings(),
    private val now: () -> Instant = { Instant.now() },
    private val phoneZone: () -> ZoneId = { ZoneId.systemDefault() },
) {
    data class Settings(
        val windowDays: Long = 30,
        val pageSize: Int = 100,
        val chunk: Int = 500,
        /** How long a deleted nutrition item waits before the delete is sent, in case a re-created twin arrives apart from it. */
        val nutritionDeleteGrace: Duration = Duration.ofMinutes(5),
    )

    private val mapper = HealthConnectMapper(registry)
    private val flagger = QualityFlagger(registry)
    private val gate = Mutex()

    private class Tally { var upserted = 0; var deleted = 0; var refused = 0; var queued = 0 }

    private suspend fun <T> io(block: () -> T): T = withContext(Dispatchers.IO) { block() }

    /** One collection: the changes since the token, or the window when there is no usable token. A second call while one runs returns BUSY. */
    suspend fun collect(): CollectOutcome {
        if (!gate.tryLock()) return CollectOutcome(CollectOutcome.Mode.BUSY)
        val tally = Tally()
        var mode = CollectOutcome.Mode.CHANGES
        try {
            var token = state.token
            if (token != null) {
                val ok = followChanges(token, tally)
                if (!ok) { mode = CollectOutcome.Mode.WINDOW; readWindow(tally) }
            } else {
                mode = CollectOutcome.Mode.WINDOW
                readWindow(tally)
            }
            return outcome(mode, tally, null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            return outcome(mode, tally, e.javaClass.simpleName)
        } finally {
            gate.unlock()
        }
    }

    private fun outcome(mode: CollectOutcome.Mode, t: Tally, failure: String?) =
        CollectOutcome(mode, t.upserted, t.deleted, t.refused, t.queued, failure)

    /** Applies pages of changes until there are no more; false when the token is too old to use. */
    private suspend fun followChanges(start: String, t: Tally): Boolean {
        var token = start
        while (true) {
            val page = gateway.changes(token)
            if (page.tokenExpired) return false
            // the last change to a record wins: a record changed and then deleted in one page is gone, one deleted and re-created is there
            val last = LinkedHashMap<String, HcChange>()
            for (c in page.changes) last[if (c is HcChange.Upsert) c.record.id else (c as HcChange.Delete).recordId] = c
            val upserts = last.values.filterIsInstance<HcChange.Upsert>().map { it.record }
            val deletes = last.values.filterIsInstance<HcChange.Delete>().map { it.recordId }
            io { applyDeletes(deletes, t) }
            for (record in upserts) io { applyUpsert(record, t) }
            // only now, with everything of this page committed, may the token move on
            io { state.token = page.nextToken }
            token = page.nextToken
            if (!page.hasMore) return true
        }
    }

    private suspend fun readWindow(t: Tally) {
        val newToken = gateway.changesToken() // taken before the read: what changes while reading is delivered afterwards
        val to = now()
        val from = to.minus(Duration.ofDays(settings.windowDays))
        val seen = HashSet<String>()
        for (type in HcType.entries) {
            var pageToken: String? = null
            do {
                val page = gateway.readPage(type, from, to, pageToken, settings.pageSize)
                for (record in page.records) {
                    seen += record.id
                    io { applyUpsert(record, t) }
                }
                pageToken = page.nextPageToken
            } while (pageToken != null)
        }
        // records seen before in this window and not seen now were deleted while the token was lost
        val gone = io { queue.ledgerSince(from.toEpochMilli()).map { it.recordId }.filter { it !in seen } }
        io { applyDeletes(gone, t) }
        io { state.token = newToken }
    }

    private fun applyDeletes(recordIds: List<String>, t: Tally) {
        val plain = ArrayList<String>()
        val held = ArrayList<String>()
        val removed = ArrayList<String>()
        for (id in recordIds) {
            val entry = queue.ledgerEntry(id) ?: continue // never seen (created and deleted between two reads): nothing was uploaded
            (if (entry.contentKey != null) held else plain) += queue.keysForGroup(entry.group)
            removed += id
            t.deleted++
        }
        if (removed.isEmpty()) return
        // a nutrition delete waits a grace period: its re-created twin may arrive in the next change page
        val hold = now().plus(settings.nutritionDeleteGrace)
        if (held.isNotEmpty()) queue.apply(ChangeSet(deleteKeys = held, holdDeletesUntil = hold))
        queue.apply(ChangeSet(deleteKeys = plain, ledgerRemove = removed))
    }

    private fun applyUpsert(record: HcRecord, t: Tally) {
        val existing = queue.ledgerEntry(record.id)
        val group: String
        val contentKey: String?
        val items: List<IngestItem>
        try {
            if (record is HcRecord.Nutrition) {
                contentKey = mapper.contentKey(record)
                group = if (existing?.contentKey == contentKey) existing.group else "$contentKey#${freeOrdinal(contentKey, record.id)}"
                items = mapper.items(record, now(), phoneZone(), group)
            } else {
                contentKey = null
                group = record.id
                items = mapper.items(record, now(), phoneZone())
            }
        } catch (e: MappingException) {
            t.refused++
            return
        }
        val flagged = items.map { it.copy(sample = flagger.applied(it.sample)) }
        val newKeys = flagged.mapTo(HashSet()) { it.key }
        val stale = existing?.let { queue.keysForGroup(it.group).filter { k -> k !in newKeys } } ?: emptyList()
        val entry = LedgerEntry(record.id, group, contentKey, startOf(record).toEpochMilli())
        val chunks = flagged.chunked(settings.chunk)
        for (chunk in chunks.dropLast(1)) {
            queue.apply(ChangeSet(upserts = chunk))
        }
        // the last chunk carries the deletions and the ledger: the record is "seen" only when all its samples are queued
        val last = chunks.lastOrNull() ?: emptyList()
        queue.apply(ChangeSet(upserts = last, deleteKeys = stale, ledgerPut = listOf(entry)))
        t.upserted++
        t.queued += flagged.size
    }

    /** The smallest ordinal (from 1) no other live record of this content key holds. */
    private fun freeOrdinal(contentKey: String, recordId: String): Int {
        val used = queue.ledgerForContentKey(contentKey).filter { it.recordId != recordId }.mapNotNull { it.group.substringAfterLast('#', "").toIntOrNull() }.toSet()
        return generateSequence(1) { it + 1 }.first { it !in used }
    }

    private fun startOf(r: HcRecord): Instant = when (r) {
        is HcRecord.HeartRate -> r.startTime
        is HcRecord.Instantaneous -> r.time
        is HcRecord.Sleep -> r.startTime
        is HcRecord.Hydration -> r.startTime
        is HcRecord.Nutrition -> r.startTime
    }
}
