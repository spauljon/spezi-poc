package com.aboutobjects.healthgate.probe

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AggregateTest {
    private fun rec(
        origin: String, start: Long, end: Long, samples: Int = 1, fields: Set<String> = emptySet(), method: Int = 0,
        idHash: String = "h\$start\$origin", mealType: Int = -1, startHour: Int = 0,
    ) =
        RecordSummary(origin, start, end, true, true, false, false, false, method, samples, fields, idHash, mealType, startHour)

    @Test fun statsAreMinMedianMax() {
        assertEquals(Stats(1, 3, 9), Aggregate.stats(listOf(9, 1, 3)))
        assertNull(Aggregate.stats(emptyList()))
    }

    @Test fun overlapCountsOnlyDifferentApps() {
        val same = listOf(rec("a", 0, 100), rec("a", 50, 150))
        assertEquals("same app overlapping is not counted", 0, Aggregate.overlappingOriginPairs(same))
        val different = listOf(rec("a", 0, 100), rec("b", 50, 150))
        assertEquals("positive control: different apps overlapping is counted", 1, Aggregate.overlappingOriginPairs(different))
        val apart = listOf(rec("a", 0, 100), rec("b", 101, 150))
        assertEquals(0, Aggregate.overlappingOriginPairs(apart))
    }

    @Test fun instantRecordsOverlapOnlyAtTheSameMillisecond() {
        assertEquals(1, Aggregate.overlappingOriginPairs(listOf(rec("a", 5, 5), rec("b", 5, 5))))
        assertEquals(0, Aggregate.overlappingOriginPairs(listOf(rec("a", 5, 5), rec("b", 6, 6))))
    }

    @Test fun aFewMillisecondsAfterTheEndIsNotAnEdit() {
        assertEquals(false, Aggregate.updatedAfterEnd(lastModifiedMs = 1_005, endMs = 1_000))
        assertEquals(false, Aggregate.updatedAfterEnd(1_000 + Aggregate.EDIT_TOLERANCE_MS, 1_000))
        assertEquals("positive control: a later edit is counted", true, Aggregate.updatedAfterEnd(1_001 + Aggregate.EDIT_TOLERANCE_MS, 1_000))
    }

    @Test fun idsSeenBeforeCountsOnlyIdsFromThePreviousRead() {
        val records = listOf(rec("a", 0, 1, idHash = "x"), rec("a", 2, 3, idHash = "y"))
        assertEquals(null, Aggregate.report("T", true, records, false).idsSeenBefore)
        assertEquals("a rewritten record has a new id", 1, Aggregate.report("T", true, records, false, previousIds = setOf("x", "gone")).idsSeenBefore)
        assertEquals(0, Aggregate.report("T", true, records, false, previousIds = setOf("p", "q")).idsSeenBefore)
        assertEquals(2, Aggregate.report("T", true, records, false, previousIds = setOf("x", "y")).idsSeenBefore)
    }

    @Test fun mealTypesAndStartHoursAreCounted() {
        val records = listOf(
            rec("a", 0, 1, mealType = 1, startHour = 7),
            rec("a", 2, 3, mealType = 2, startHour = 7),
            rec("a", 4, 5, mealType = 2, startHour = 12),
            rec("a", 6, 7), // a type with no meal type is not counted as one
        )
        val r = Aggregate.report("T", true, records, false)
        assertEquals(mapOf("BREAKFAST" to 1, "LUNCH" to 2), r.mealTypes)
        assertEquals(mapOf(0 to 1, 7 to 2, 12 to 1), r.startHours)
    }

    @Test fun idHashIsStableShortAndNotTheId() {
        assertEquals(Aggregate.idHash("record-1"), Aggregate.idHash("record-1"))
        assertEquals(16, Aggregate.idHash("record-1").length)
        assertEquals(false, Aggregate.idHash("record-1").contains("record"))
    }

    @Test fun reportCounts() {
        val r = Aggregate.report(
            "T", true,
            listOf(
                rec("a", 0, 60_000, samples = 3, fields = setOf("x"), method = 1),
                rec("b", 0, 120_000, samples = 5, fields = setOf("x", "y"), method = 3),
            ),
            capped = false,
        )
        assertEquals(2, r.count)
        assertEquals(mapOf("a" to 1, "b" to 1), r.origins)
        assertEquals(mapOf("ACTIVELY_RECORDED" to 1, "MANUAL_ENTRY" to 1), r.recordingMethods)
        assertEquals(mapOf("x" to 2, "y" to 1), r.fieldCounts)
        assertEquals(Stats(1, 2, 2), r.spanMinutes)
        assertEquals(1, r.overlappingOriginPairs)
    }

    @Test fun deniedTypeSaysSoAndShowsNoCounts() {
        val text = ReportFormatter.format(Aggregate.report("T", false, emptyList(), false))
        assertEquals(true, text.contains("read permission not granted"))
        assertEquals(false, text.contains("records:"))
    }
}
