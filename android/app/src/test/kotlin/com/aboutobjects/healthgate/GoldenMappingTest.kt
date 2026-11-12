package com.aboutobjects.healthgate

import com.aboutobjects.healthgate.mapping.Measurement
import com.aboutobjects.healthgate.mapping.MappingError
import com.aboutobjects.healthgate.mapping.MappingException
import com.aboutobjects.healthgate.mapping.MappingOutcome
import com.aboutobjects.healthgate.mapping.MetricSample
import com.aboutobjects.healthgate.mapping.ObservationMapper
import com.aboutobjects.healthgate.mapping.SampleSource
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class GoldenMappingTest {
    private val mapper = ObservationMapper(Golden.registry())
    private val patient = "example-patient"

    private fun observation(o: MappingOutcome): JsonObject = (o as MappingOutcome.Observation).resource

    @Test fun fixturesWereFound() {
        // a loader that found nothing would pass every test below
        assertTrue(Golden.cases("observations-quantity.json").size >= 30)
        assertTrue(Golden.cases("observations-sleep.json").size >= 10)
        assertTrue(Golden.cases("errors.json").size >= 5)
    }

    private fun runFile(file: String): Int {
        var mapped = 0
        for (case in Golden.cases(file)) {
            val name = Golden.string(case, "name")
            val outcome = mapper.map(Golden.sample(case.getValue("sample").jsonObject), Golden.string(case, "patientId")!!, Golden.string(case, "deviceReference"))
            if (Golden.string(case, "expectedOutcome") == "unmapped") {
                assertTrue("$name: expected unmapped, got $outcome", outcome is MappingOutcome.Unmapped)
                continue
            }
            val expected = case.getValue("expected")
            val actual = observation(outcome)
            assertTrue("$name\n expected: $expected\n   actual: $actual", Golden.same(expected, actual))
            mapped++
        }
        return mapped
    }

    @Test fun quantityMetricsMapToExactlyTheIndependentGeneratorsJson() {
        assertTrue(runFile("observations-quantity.json") >= 30)
    }

    @Test fun sleepStagesMapToExactlyTheGeneratorsJsonAndInBedToNothing() {
        assertTrue(runFile("observations-sleep.json") >= 10)
        // control for the unmapped branch: the fixtures do contain an unmapped case, and it is that stage
        val unmapped = Golden.cases("observations-sleep.json").filter { Golden.string(it, "expectedOutcome") == "unmapped" }
        assertTrue(unmapped.isNotEmpty())
        for (c in unmapped) {
            val outcome = mapper.map(Golden.sample(c.getValue("sample").jsonObject), patient)
            assertEquals(MappingOutcome.Unmapped("inBed"), outcome)
        }
    }

    @Test fun refusedSamplesFailWithTheStatedReason() {
        val cases = Golden.cases("errors.json")
        for (case in cases) {
            val expected = Golden.string(case, "expectedError")!!
            val name = Golden.string(case, "name")
            try {
                mapper.map(Golden.sample(case.getValue("sample").jsonObject), patient)
                fail("$name: expected $expected but the sample was accepted")
            } catch (e: MappingException) {
                assertEquals("$name: got ${e.error.code}", expected, e.error.code)
            }
        }
        // the control: the refusal check can see an acceptance (every golden quantity case maps)
        assertTrue(runFile("observations-quantity.json") > 0)
    }

    private fun heartRate(value: Double, id: String = "x", zone: ZoneId = ZoneOffset.UTC, source: String = SampleSource.SYNTHETIC) =
        Instant.ofEpochSecond(1_768_494_605).let { t ->
            MetricSample(Measurement.Quantity("heartRate", value), t, t, t, zone, source, id)
        }

    @Test fun nonFiniteValuesAreRefusedAsSuch() {
        for (v in listOf(Double.NaN, Double.POSITIVE_INFINITY, Double.NEGATIVE_INFINITY)) {
            try {
                mapper.map(heartRate(v), patient)
                fail("$v was accepted")
            } catch (e: MappingException) {
                assertEquals(MappingError.NON_FINITE_VALUE, e.error)
            }
        }
        mapper.map(heartRate(72.0), patient) // the control: a normal value is accepted
    }

    @Test fun anEmptyPatientIdIsRefused() {
        try {
            mapper.map(heartRate(72.0), " ")
            fail("accepted")
        } catch (e: MappingException) {
            assertEquals(MappingError.EMPTY_PATIENT_ID, e.error)
        }
    }

    @Test fun anOffsetThatIsNotWholeMinutesIsRefusedNotRounded() {
        try {
            mapper.map(heartRate(72.0, zone = ZoneOffset.ofTotalSeconds(3601)), patient) // +01:00:01
            fail("accepted")
        } catch (e: MappingException) {
            assertEquals(MappingError.OFFSET_NOT_WHOLE_MINUTES, e.error)
        }
        mapper.map(heartRate(72.0, zone = ZoneOffset.ofTotalSeconds(3600)), patient) // the control: +01:00
    }

    @Test fun outputNeverUsesZAndEveryDateTimeCarriesANumericOffset() {
        val pattern = Regex("""^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?[+-]\d{2}:\d{2}$""")
        var checked = 0
        for (file in listOf("observations-quantity.json", "observations-sleep.json")) {
            for (case in Golden.cases(file)) {
                val outcome = mapper.map(Golden.sample(case.getValue("sample").jsonObject), patient)
                val o = (outcome as? MappingOutcome.Observation)?.resource ?: continue
                val strings = mutableListOf(o.getValue("issued").jsonPrimitive.content)
                o["effectiveDateTime"]?.let { strings += it.jsonPrimitive.content }
                o["effectivePeriod"]?.jsonObject?.let { strings += it.getValue("start").jsonPrimitive.content; strings += it.getValue("end").jsonPrimitive.content }
                for (s in strings) {
                    assertTrue("$s in ${Golden.string(case, "name")}", pattern.matches(s))
                    checked++
                }
            }
        }
        assertTrue("only $checked date strings were examined", checked >= 24)
    }

    @Test fun theSameInputGivesTheSameOutputAndTheIdentifierDoesNotDependOnIssued() {
        val s = heartRate(72.0, id = "syn-1")
        assertEquals(mapper.map(s, patient, "Device/d"), mapper.map(s, patient, "Device/d"))
        val later = s.copy(issued = s.issued.plusSeconds(3600))
        val a = observation(mapper.map(s, patient)).getValue("identifier")
        val b = observation(mapper.map(later, patient)).getValue("identifier")
        assertEquals(a, b)
        assertNotEquals(observation(mapper.map(s, patient)).getValue("issued"), observation(mapper.map(later, patient)).getValue("issued"))
    }

    @Test fun aHealthKitIdIsLowercasedAndASyntheticIdIsNot() {
        val hk = observation(mapper.map(heartRate(72.0, id = "AB-CD", source = SampleSource.HEALTH_KIT), patient))
        val syn = observation(mapper.map(heartRate(72.0, id = "AB-CD"), patient))
        assertEquals("ab-cd", hk.getValue("identifier").toString().let { Regex("\"value\":\"([^\"]+)\"").find(it)!!.groupValues[1] })
        assertEquals("AB-CD", syn.getValue("identifier").toString().let { Regex("\"value\":\"([^\"]+)\"").find(it)!!.groupValues[1] })
    }

    @Test fun theOwnCodeSystemMetricMapsWithItsCodeInTextAndNoLoinc() {
        // hrvRmssd is read by Health Connect only (M27), but the mapper must already handle a metric coded in the project's system
        val t = Instant.ofEpochSecond(1_768_494_605)
        val o = observation(mapper.map(MetricSample(Measurement.Quantity("hrvRmssd", 48.3), t, t, t, ZoneOffset.UTC, SampleSource.SYNTHETIC, "x"), patient))
        val code = o.getValue("code").jsonObject
        assertEquals("Heart rate variability (RMSSD)", code.getValue("text").jsonPrimitive.content)
        assertTrue(code.toString().contains("hrv-rmssd") && !code.toString().contains("loinc.org"))
    }
}
