package com.aboutobjects.healthgate

import com.aboutobjects.healthgate.contract.ContractException
import com.aboutobjects.healthgate.contract.MetricRegistry
import com.aboutobjects.healthgate.mapping.DeviceMapper
import com.aboutobjects.healthgate.mapping.Measurement
import com.aboutobjects.healthgate.mapping.MappingException
import com.aboutobjects.healthgate.mapping.MetricSample
import com.aboutobjects.healthgate.mapping.QualityFlagger
import com.aboutobjects.healthgate.mapping.SampleSource
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class DeviceGoldenTest {
    private val mapper = DeviceMapper(Golden.registry())

    @Test fun devicesMapToExactlyTheGeneratorsKeysAndResources() {
        val cases = Golden.cases("devices.json")
        assertTrue(cases.size >= 10)
        var accepted = 0
        var refused = 0
        for (case in cases) {
            val name = Golden.string(case, "name")
            val descriptor = Golden.descriptor(case.getValue("descriptor").jsonObject)
            val patient = Golden.string(case, "patientId")!!
            val expectedError = Golden.string(case, "expectedError")
            if (expectedError != null) {
                try {
                    mapper.map(descriptor, patient)
                    fail("$name: expected $expectedError but the device was accepted")
                } catch (e: MappingException) {
                    assertEquals(name, expectedError, e.error.code)
                }
                refused++
                continue
            }
            Golden.string(case, "expectedKey")?.let { assertEquals("$name key", it, mapper.key(descriptor)) }
            val actual = mapper.map(descriptor, patient)
            assertTrue("$name\n expected: ${case["expected"]}\n   actual: $actual", Golden.same(case.getValue("expected"), actual))
            accepted++
        }
        // the refusals have their control: both outcomes occur in the fixtures
        assertTrue("accepted $accepted", accepted >= 8)
        assertTrue("refused $refused", refused >= 2)
    }

    @Test fun oneAppIsOneDeviceUnderAnyDisplayName() {
        val a = mapper.key(Golden.descriptor(buildJsonObject { put("kind", "sourceApp"); put("name", "A"); put("bundleIdentifier", "com.example.x") }))
        val b = mapper.key(Golden.descriptor(buildJsonObject { put("kind", "sourceApp"); put("name", "B"); put("bundleIdentifier", " com.example.x ") }))
        assertEquals(a, b)
    }
}

class FlagGoldenTest {
    private val registry = Golden.registry()
    private val flagger = QualityFlagger(registry)

    @Test fun flagsAreExactlyThoseTheGeneratorExpectsAtEveryBoundary() {
        val cases = Golden.cases("flags.json")
        assertTrue(cases.size >= 40)
        var flagged = 0
        var clean = 0
        for (case in cases) {
            val input = case.getValue("input").jsonObject
            val end = Instant.parse(Golden.string(input, "end")!!)
            val measurement = if (input.containsKey("value")) Measurement.Quantity(Golden.string(input, "metric")!!, input.getValue("value").jsonPrimitive.content.toDouble())
            else Measurement.Sleep(Golden.string(input, "stage")!!)
            val sample = MetricSample(measurement, end, end, Instant.parse(Golden.string(input, "issued")!!), ZoneOffset.UTC, SampleSource.SYNTHETIC, "x")
            val codes = buildList {
                if (flagger.isArtifact(sample)) add(registry.dataQualityFlags.getValue("artifactSuspected"))
                if (flagger.isLate(sample)) add(registry.dataQualityFlags.getValue("lateArrival"))
            }.sorted()
            val expected = case.getValue("expectedFlags").jsonArray.map { it.jsonPrimitive.content }
            assertEquals(Golden.string(case, "name"), expected, codes)
            if (expected.isEmpty()) clean++ else flagged++
        }
        assertTrue("both outcomes must occur: flagged $flagged, clean $clean", flagged >= 5 && clean >= 10)
    }

    @Test fun applyingSetsFlagsAndNeverClearsOne() {
        val t = Instant.parse("2026-01-15T16:30:05Z")
        val spike = MetricSample(Measurement.Quantity("heartRate", 280.0), t, t, t, ZoneOffset.UTC, SampleSource.SYNTHETIC, "x")
        assertTrue(flagger.applied(spike).artifactSuspected)
        val fine = spike.copy(measurement = Measurement.Quantity("heartRate", 72.0), artifactSuspected = true)
        assertTrue("an existing flag is kept", flagger.applied(fine).artifactSuspected)
        assertTrue(!flagger.applied(fine.copy(artifactSuspected = false)).artifactSuspected)
    }
}

class MealGoldenTest {
    private val registry = Golden.registry()

    @Test fun mealLabelsNormaliseAsTheGeneratorSays() {
        val cases = Golden.cases("meals.json")
        assertTrue(cases.size >= 8)
        var noMeal = 0
        for (case in cases) {
            val meal = registry.meal(Golden.string(case, "label"))
            val expected = case.getValue("expected")
            if (expected is JsonNull) {
                assertNull("${Golden.string(case, "name")}: no label is no meal", meal)
                noMeal++
                continue
            }
            assertTrue(Golden.string(case, "name"), meal != null)
            assertEquals(Golden.string(case, "name"), Golden.string(expected.jsonObject, "code"), meal?.code)
            assertEquals(Golden.string(case, "name"), Golden.string(expected.jsonObject, "label"), meal?.label)
        }
        assertTrue("the fixtures hold both a meal and no-meal outcomes", noMeal >= 2)
        assertNull("no label is no meal", registry.meal("  "))
        assertNull(registry.meal(null))
    }
}

class RegistryTest {
    private val text = Golden.contractCopy.readText()

    private fun mutated(change: (MutableMap<String, kotlinx.serialization.json.JsonElement>) -> Unit): String {
        val map = Json.parseToJsonElement(text).jsonObject.toMutableMap()
        change(map)
        return JsonObject(map).toString()
    }

    @Test fun theBundledCopyIsByteIdenticalToTheContract() {
        assertTrue("the contract source was not found", Golden.contractSource.isFile)
        assertEquals("run contract/sync.sh", Golden.contractSource.readText(), text)
    }

    @Test fun theContractLoadsAndKnowsTheMetricsThisAppNeeds() {
        val r = MetricRegistry.parse(text)
        assertTrue(r.contractVersion.startsWith("1."))
        for (id in listOf("heartRate", "restingHeartRate", "hrvSdnn", "hrvRmssd", "dietaryEnergy", "dietaryWater")) assertTrue(id, r.metric(id) != null)
        assertTrue(r.sleep != null)
    }

    private fun refused(json: String) {
        try {
            MetricRegistry.parse(json)
            fail("accepted")
        } catch (e: ContractException) {
            // the stated kind of refusal
        }
    }

    @Test fun aNewerMajorVersionIsRefused() {
        MetricRegistry.parse(text) // the control: the unchanged contract is accepted
        refused(mutated { it["contractVersion"] = JsonPrimitive("2.0.0") })
    }

    @Test fun aContractWithoutTheSleepMetricIsRefused() {
        refused(mutated { m -> m["metrics"] = JsonArray(m.getValue("metrics").jsonArray.filter { it.jsonObject["kind"]?.jsonPrimitive?.content != "sleepStage" }) })
    }

    @Test fun aMetricCodedInAnUnknownOwnSystemIsRefused() {
        // hrvRmssd uses systems.metric: a contract whose customCode names a system this code does not know is refused
        refused(mutated { m ->
            m["metrics"] = JsonArray(m.getValue("metrics").jsonArray.map { e ->
                val o = e.jsonObject
                if (o["id"]?.jsonPrimitive?.content != "hrvRmssd") o else JsonObject(o.toMutableMap().also { x ->
                    x["customCode"] = buildJsonObject { put("system", "nope"); put("code", "c"); put("display", "d") }
                })
            })
        })
    }

    @Test fun aContractWithoutTheUserEnteredFlagIsRefused() {
        refused(mutated { m -> m["dataQualityFlags"] = JsonObject(m.getValue("dataQualityFlags").jsonObject.filterKeys { it != "userEntered" }) })
    }

    @Test fun aDuplicateMetricIdIsRefused() {
        refused(mutated { m -> val ms = m.getValue("metrics").jsonArray; m["metrics"] = JsonArray(ms + ms.first()) })
    }
}
