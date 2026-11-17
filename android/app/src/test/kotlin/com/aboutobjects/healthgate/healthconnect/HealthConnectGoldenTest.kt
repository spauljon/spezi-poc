package com.aboutobjects.healthgate.healthconnect

import com.aboutobjects.healthgate.Golden
import com.aboutobjects.healthgate.ingest.healthconnect.HealthConnectMapper
import com.aboutobjects.healthgate.mapping.DeviceMapper
import com.aboutobjects.healthgate.mapping.MappingException
import com.aboutobjects.healthgate.mapping.MappingOutcome
import com.aboutobjects.healthgate.mapping.ObservationMapper
import com.aboutobjects.healthgate.mapping.QualityFlagger
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The Kotlin record mapper against the independent generator's Health Connect fixtures (contract 1.7.0). */
class HealthConnectGoldenTest {
    private val registry = Golden.registry()
    private val records = HealthConnectMapper(registry)
    private val observations = ObservationMapper(registry)
    private val flagger = QualityFlagger(registry)

    /** The case through the whole path a sample takes: record mapper, quality flagger, Observation mapper. */
    private fun run(case: JsonObject): List<JsonObject> {
        val record = HcGolden.record(case.getValue("record").jsonObject)
        val issued = Instant.parse(Golden.string(case, "issued")!!)
        val phone = ZoneId.of(Golden.string(case, "phoneTimeZone")!!)
        val items = records.items(record, issued, phone, Golden.string(case, "nutritionGroup"))
        return items.map { item ->
            val outcome = observations.map(flagger.applied(item.sample), Golden.string(case, "patientId")!!, Golden.string(case, "deviceReference"))
            (outcome as MappingOutcome.Observation).resource
        }
    }

    @Test fun everyCaseGivesExactlyTheGeneratorsObservations() {
        val cases = Golden.cases("healthconnect-observations.json")
        assertTrue("fixtures found: ${cases.size}", cases.size >= 19)
        var observations = 0
        for (case in cases) {
            val name = Golden.string(case, "name")
            val actual = run(case)
            val expected = case.getValue("expected").jsonArray
            assertEquals("$name: how many Observations", expected.size, actual.size)
            for ((i, e) in expected.withIndex()) {
                assertTrue("$name #$i\n expected: $e\n   actual: ${actual[i]}", Golden.same(e, actual[i]))
            }
            observations += actual.size
        }
        assertTrue("observations compared: $observations", observations >= 40)
    }

    @Test fun everyRefusalGivesTheGeneratorsErrorCode() {
        val cases = Golden.cases("healthconnect-errors.json")
        assertTrue(cases.size >= 4)
        for (case in cases) {
            val name = Golden.string(case, "name")
            val expected = Golden.string(case, "expectedError")!!
            try {
                run(case)
                fail("$name: expected $expected but the record was accepted")
            } catch (e: MappingException) {
                assertEquals(name, expected, e.error.code)
            }
        }
        // the control: the same machinery accepts a good record (the first observation case)
        assertTrue(run(Golden.cases("healthconnect-observations.json").first()).isNotEmpty())
    }

    @Test fun flagsAtEveryBoundaryAreTheGeneratorsOwn() {
        val cases = Golden.cases("healthconnect-flags.json")
        var flagged = 0
        var clean = 0
        for (case in cases) {
            val input = case.getValue("input").jsonObject
            val end = Instant.parse(Golden.string(input, "end")!!)
            val sample = com.aboutobjects.healthgate.mapping.MetricSample(
                com.aboutobjects.healthgate.mapping.Measurement.Quantity(Golden.string(input, "metric")!!, input.getValue("value").jsonPrimitive.content.toDouble()),
                end, end, Instant.parse(Golden.string(input, "issued")!!), java.time.ZoneOffset.UTC, com.aboutobjects.healthgate.mapping.SampleSource.HEALTH_CONNECT, "x",
            )
            val applied = flagger.applied(sample)
            val codes = buildList {
                if (applied.artifactSuspected) add(registry.dataQualityFlags.getValue("artifactSuspected"))
                if (applied.lateArrival) add(registry.dataQualityFlags.getValue("lateArrival"))
            }.sorted()
            val expected = case.getValue("expectedFlags").jsonArray.map { it.jsonPrimitive.content }
            assertEquals(Golden.string(case, "name"), expected, codes)
            if (expected.isEmpty()) clean++ else flagged++
        }
        assertTrue("both outcomes occur: flagged $flagged, clean $clean", flagged >= 2 && clean >= 2)
    }

    @Test fun devicesAndAppSourcesGiveTheGeneratorsKeysAndResources() {
        val devices = DeviceMapper(registry)
        val cases = Golden.cases("healthconnect-devices.json")
        var accepted = 0
        var refused = 0
        for (case in cases) {
            val name = Golden.string(case, "name")
            val record = HcGolden.record(JsonObject(mapOf(
                "class" to kotlinx.serialization.json.JsonPrimitive("HydrationRecord"), "id" to kotlinx.serialization.json.JsonPrimitive("r"),
                "origin" to kotlinx.serialization.json.JsonPrimitive(Golden.string(case, "origin") ?: ""),
                "recordingMethod" to kotlinx.serialization.json.JsonPrimitive(2),
                "startTime" to kotlinx.serialization.json.JsonPrimitive("2026-01-15T19:00:00Z"), "endTime" to kotlinx.serialization.json.JsonPrimitive("2026-01-15T19:00:00Z"),
                "volume" to kotlinx.serialization.json.JsonPrimitive(1.0),
            ) + (case["device"]?.let { mapOf("device" to it) } ?: emptyMap())))
            val expectedError = Golden.string(case, "expectedError")
            if (expectedError != null) {
                try {
                    devices.map(records.descriptor(record), Golden.string(case, "patientId")!!)
                    fail("$name: expected $expectedError")
                } catch (e: MappingException) {
                    assertEquals(name, expectedError, e.error.code)
                }
                refused++
                continue
            }
            val descriptor = records.descriptor(record)
            assertEquals("$name key", Golden.string(case, "expectedKey"), devices.key(descriptor))
            val actual = devices.map(descriptor, Golden.string(case, "patientId")!!)
            assertTrue("$name\n expected: ${case["expected"]}\n   actual: $actual", Golden.same(case.getValue("expected"), actual))
            accepted++
        }
        assertTrue("accepted $accepted, refused $refused", accepted >= 7 && refused >= 1)
    }

    private fun idsOf(delivery: JsonObject): List<String> {
        val record = HcGolden.record(delivery.getValue("record").jsonObject)
        val group = Golden.string(delivery, "nutritionGroup")
        return records.items(record, Instant.parse("2026-01-15T16:40:00Z"), ZoneId.of("America/Los_Angeles"), group).map { it.sample.id }
    }

    @Test fun identitiesBehaveAcrossDeliveriesAsTheGeneratorSays() {
        val doc = Golden.document("healthconnect-identity.json")
        val properties = doc.getValue("properties").jsonArray.map { it.jsonObject }
        assertTrue(properties.size >= 9)
        for (p in properties) {
            val name = Golden.string(p, "name")
            val a = idsOf(p.getValue("deliveryA").jsonObject)
            val b = idsOf(p.getValue("deliveryB").jsonObject)
            assertEquals("$name A", p.getValue("identifiersA").jsonArray.map { it.jsonPrimitive.content }, a)
            assertEquals("$name B", p.getValue("identifiersB").jsonArray.map { it.jsonPrimitive.content }, b)
            assertEquals("$name shared", p.getValue("shared").jsonArray.map { it.jsonPrimitive.content }, (a.toSet() intersect b.toSet()).sorted())
        }
        // the opposites occur in the same file (the checker sees both): an edited value keeps its identity, another record id does not
        val byName = properties.associateBy { Golden.string(it, "name") }
        assertTrue(byName.getValue("identity-edited-sample-value-keeps-its-identity").getValue("shared").jsonArray.size == 2)
        assertTrue(byName.getValue("identity-another-record-id-is-another-sample").getValue("shared").jsonArray.isEmpty())
    }

    @Test fun canonicalValuesContentKeysAndLookupsMatch() {
        val doc = Golden.document("healthconnect-identity.json")
        for (c in doc.getValue("canonicalValues").jsonArray.map { it.jsonObject }) {
            assertEquals(c.toString(), Golden.string(c, "canonical"), HealthConnectMapper.canonicalValue(c.getValue("value").jsonPrimitive.content.toDouble()))
        }
        for (c in doc.getValue("contentKeys").jsonArray.map { it.jsonObject }) {
            val record = HcGolden.record(c.getValue("record").jsonObject) as com.aboutobjects.healthgate.ingest.healthconnect.HcRecord.Nutrition
            assertEquals(Golden.string(c, "contentKey"), records.contentKey(record))
            assertEquals(Golden.string(c, "groupValue"), records.contentKey(record) + "#1")
        }
        for (l in doc.getValue("groupLookups").jsonArray.map { it.jsonObject }) {
            assertEquals(Golden.string(l, "searchToken"), registry.systems.identifier.getValue("healthConnectGroup") + "|" + Golden.string(l, "groupValue"))
        }
    }
}
