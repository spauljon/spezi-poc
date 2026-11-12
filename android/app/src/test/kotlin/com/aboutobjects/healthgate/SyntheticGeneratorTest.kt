package com.aboutobjects.healthgate

import com.aboutobjects.healthgate.ingest.SyntheticConfig
import com.aboutobjects.healthgate.ingest.SyntheticGenerator
import com.aboutobjects.healthgate.ingest.SyntheticSource
import com.aboutobjects.healthgate.mapping.Measurement
import com.aboutobjects.healthgate.mapping.MappingOutcome
import com.aboutobjects.healthgate.mapping.ObservationMapper
import com.aboutobjects.healthgate.mapping.QualityFlagger
import java.io.File
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SyntheticGeneratorTest {
    private val registry = Golden.registry()
    private val generator = SyntheticGenerator(registry)
    private val config = SyntheticConfig(seed = 7, zone = ZoneId.of("UTC"))
    private val day0: Instant = LocalDate.of(2026, 3, 2).atStartOfDay(ZoneId.of("UTC")).toInstant()
    private val threeDays = day0.plus(Duration.ofDays(3))

    private fun window() = generator.generate(config, day0, threeDays, threeDays)
    private fun metric(items: List<com.aboutobjects.healthgate.ingest.IngestItem>, id: String) =
        items.filter { (it.sample.measurement as? Measurement.Quantity)?.metricId == id }

    @Test fun aThreeDayWindowHasExactlyTheCountsTheConfigImplies() {
        val items = window()
        assertEquals("heart rate: 3 days of 5-minute readings", 3 * 24 * 60 / 5, metric(items, "heartRate").size)
        assertEquals("resting heart rate: one per whole day", 3, metric(items, "restingHeartRate").size)
        assertEquals("HRV: one per morning", 3, metric(items, "hrvRmssd").size)
        val intakeIds = registry.metrics.filter { it.kind == "intake" }.map { it.id }
        assertEquals("eight nutrients in three meals, three days", 3 * 3 * intakeIds.size, items.count { (it.sample.measurement as? Measurement.Quantity)?.metricId in intakeIds })
        // two whole nights (the evenings of days 0 and 1) lie inside the window: five 90-minute cycles each
        val nights = items.filter { it.sample.measurement is Measurement.Sleep }
            .filter { it.sample.start >= day0.plus(Duration.ofHours(23)) && it.sample.start < day0.plus(Duration.ofDays(2)).plus(Duration.ofHours(23)) }
        assertEquals("two nights of 450 minutes", 2 * 450L, nights.sumOf { Duration.between(it.sample.start, it.sample.end).toMinutes() })
    }

    @Test fun sleepIntervalsOfANightAreContiguousAndNeverOverlap() {
        val sleep = window().filter { it.sample.measurement is Measurement.Sleep }.sortedBy { it.sample.start }
        assertTrue(sleep.isNotEmpty())
        for ((a, b) in sleep.zipWithNext()) {
            assertTrue("overlap: ${a.sample.end} after ${b.sample.start}", a.sample.end <= b.sample.start)
        }
        assertTrue("a night uses the contract's stages, including deep and REM",
            sleep.map { (it.sample.measurement as Measurement.Sleep).stage }.toSet().containsAll(listOf("asleepCore", "asleepDeep", "asleepREM", "awake")))
    }

    @Test fun theSameCallGivesTheSameSamplesAndAnotherSeedGivesOthers() {
        assertEquals(window(), window())
        val other = generator.generate(config.copy(seed = 8), day0, threeDays, threeDays)
        assertNotEquals("another seed must change the values", window().map { it.sample.measurement }, other.map { it.sample.measurement })
    }

    @Test fun anOverlappingWindowRepeatsIdsInsteadOfInventingNewOnes() {
        val a = generator.generate(config, day0, day0.plus(Duration.ofDays(2)), threeDays).map { it.key }.toSet()
        val b = generator.generate(config, day0.plus(Duration.ofDays(1)), threeDays, threeDays).map { it.key }.toSet()
        val both = generator.generate(config, day0, threeDays, threeDays).map { it.key }
        assertTrue("the two windows overlap", (a intersect b).isNotEmpty())
        assertEquals("every key is unique", both.size, both.toSet().size)
        assertTrue("the overlap's keys exist in the combined window with the same text", (a intersect b).all { it in both })
    }

    @Test fun everySampleMapsAndNoneIsFlaggedAnArtifact() {
        val mapper = ObservationMapper(registry)
        val flagger = QualityFlagger(registry)
        for (item in window()) {
            val outcome = mapper.map(flagger.applied(item.sample), "p1")
            assertTrue("${item.key} was not mapped to an Observation: $outcome", outcome is MappingOutcome.Observation)
            assertTrue("${item.key} is outside its plausible range", !flagger.isArtifact(item.sample))
        }
        // lateness is judged against `issued`: a one-day window issued at its end has nothing late (24 hours exactly is not late)...
        val oneDay = day0.plus(Duration.ofDays(1))
        assertTrue(generator.generate(config, day0, oneDay, oneDay).none { flagger.isLate(it.sample) })
        // ...and the control: the same samples issued three days after the window ARE late, so the check can see one
        assertTrue(generator.generate(config, day0, oneDay, oneDay.plus(Duration.ofDays(3))).any { flagger.isLate(it.sample) })
    }

    @Test fun intakesCarryTheirMealAndTheOthersCarryNone() {
        val items = window()
        for (it in items) {
            val isIntake = registry.metric((it.sample.measurement as? Measurement.Quantity)?.metricId ?: "sleepStage")?.kind == "intake"
            if (isIntake) assertTrue("${it.key} has no meal", it.sample.meal != null) else assertEquals(null, it.sample.meal)
        }
        assertEquals(setOf("breakfast", "lunch", "dinner"), items.mapNotNull { it.sample.meal?.code }.toSet())
    }

    @Test fun theSourceIsTheGeneratorBehindTheIngestInterface() {
        val source = SyntheticSource(generator, config)
        assertEquals(window(), source.samples(day0, threeDays, threeDays))
    }

    @Test fun anOffsetZoneMovesTheDayBoundariesWithIt() {
        val ny = config.copy(zone = ZoneId.of("America/New_York"))
        val start = LocalDate.of(2026, 3, 2).atStartOfDay(ZoneId.of("America/New_York")).toInstant()
        val items = generator.generate(ny, start, start.plus(Duration.ofDays(1)), start.plus(Duration.ofDays(1)))
        assertEquals(1, metric(items, "restingHeartRate").size)
        assertTrue("the resting day starts at local midnight", metric(items, "restingHeartRate").single().sample.start == start)
    }

    // ---- purity: no clock and no global randomness anywhere in the generator's source
    private val forbidden = Regex("""\b(Instant\.now|System\.currentTimeMillis|System\.nanoTime|LocalDateTime\.now|ZonedDateTime\.now|Clock\.system|java\.util\.Random|kotlin\.random|Random\(|Math\.random|ThreadLocalRandom|UUID\.randomUUID)""")

    private fun offenders(file: File) = forbidden.findAll(file.readText()).map { it.value }.toList()

    @Test fun theGeneratorSourceUsesNoClockAndNoGlobalRandomness() {
        val file = File("src/main/kotlin/com/aboutobjects/healthgate/ingest/SyntheticSource.kt")
        assertTrue("source found", file.isFile)
        assertEquals(emptyList<String>(), offenders(file))
        // the control: the scanner does see a violation
        val bad = File.createTempFile("gen", ".kt").apply { writeText("val t = Instant.now()\nval r = Math.random()"); deleteOnExit() }
        assertEquals(listOf("Instant.now", "Math.random"), offenders(bad))
    }
}
