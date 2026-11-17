package com.aboutobjects.healthgate.healthconnect

import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.MealType
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.metadata.Metadata
import androidx.health.connect.client.units.Energy
import androidx.health.connect.client.units.Mass
import androidx.health.connect.client.units.Volume
import com.aboutobjects.healthgate.Golden
import com.aboutobjects.healthgate.ingest.healthconnect.HcConversion
import com.aboutobjects.healthgate.ingest.healthconnect.HcRecord
import com.aboutobjects.healthgate.ingest.healthconnect.HealthConnectAccess
import java.time.Instant
import java.time.ZoneOffset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The Android adapter, with the library's own record classes: the contract's units and fields, and nothing else read. */
class HcConversionTest {
    private val t0 = Instant.parse("2026-03-10T10:00:00Z")
    private val off = ZoneOffset.ofHours(-8)

    @Test fun theNutrientsReadAreExactlyTheContractsNutritionFields() {
        val registry = Golden.registry()
        val contract = registry.metrics.filter { it.healthConnect?.record == "NutritionRecord" }.map { it.healthConnect!!.field }.toSet()
        assertEquals(contract, HealthConnectAccess.nutrientReaders.keys)
        assertEquals("read-only permissions, one per record class", HealthConnectAccess.recordClasses.size, HealthConnectAccess.readPermissions.size)
        assertTrue(HealthConnectAccess.readPermissions.all { it.startsWith("android.permission.health.READ_") })
    }

    @Test fun everyStageTheContractNamesIsOneTheAdapterProduces() {
        val sleep = Golden.registry().sleep!!.healthConnect!!
        val contract = sleep.stages!!.values.flatten().toSet() + sleep.unmapped!!
        assertEquals("the contract and the adapter name the same stage types", contract, HealthConnectAccess.stageNames.values.toSet())
        // the library's own names are different, which is why the adapter has its table (this is the control for the assertion above)
        assertTrue(SleepSessionRecord.STAGE_TYPE_INT_TO_STRING_MAP.values.none { it in contract })
    }

    @Test fun aNutritionRecordIsReadInTheContractsUnitsAndAMissingNutrientStaysMissing() {
        val record = NutritionRecord(
            startTime = t0, startZoneOffset = off, endTime = t0.plusSeconds(43200), endZoneOffset = off,
            energy = Energy.kilocalories(450.0), protein = Mass.grams(31.5), sodium = Mass.milligrams(620.0), sugar = Mass.grams(22.0),
            mealType = MealType.MEAL_TYPE_LUNCH, metadata = Metadata.manualEntry(),
        )
        val converted = HcConversion.convert(record) as HcRecord.Nutrition
        assertEquals(450.0, converted.nutrients.getValue("energy"), 0.0)
        assertEquals(31.5, converted.nutrients.getValue("protein"), 0.0)
        assertEquals("sodium is milligrams", 620.0, converted.nutrients.getValue("sodium"), 0.0)
        assertEquals(22.0, converted.nutrients.getValue("sugar"), 0.0)
        assertNull("absent, not zero", converted.nutrients["totalFat"])
        assertEquals(2, converted.mealType)
        assertEquals(3, converted.recordingMethod)
        assertEquals(off, converted.startOffset)
    }

    @Test fun hydrationIsMillilitersHeartRateKeepsItsSamplesAndSleepKeepsStageNames() {
        val water = HcConversion.convert(HydrationRecord(t0, off, t0.plusSeconds(1), off, Volume.liters(0.25), Metadata.manualEntry())) as HcRecord.Hydration
        assertEquals(250.0, water.milliliters, 1e-9)

        val hr = HcConversion.convert(
            HeartRateRecord(t0, off, t0.plusSeconds(60), off, listOf(HeartRateRecord.Sample(t0, 72), HeartRateRecord.Sample(t0.plusSeconds(30), 74)), Metadata.manualEntry()),
        ) as HcRecord.HeartRate
        assertEquals(listOf(72.0, 74.0), hr.samples.map { it.beatsPerMinute })

        val sleep = HcConversion.convert(
            SleepSessionRecord(
                t0, off, t0.plusSeconds(3600), off, Metadata.manualEntry(), null, null,
                listOf(SleepSessionRecord.Stage(t0, t0.plusSeconds(1800), SleepSessionRecord.STAGE_TYPE_DEEP), SleepSessionRecord.Stage(t0.plusSeconds(1800), t0.plusSeconds(3600), SleepSessionRecord.STAGE_TYPE_LIGHT)),
            ),
        ) as HcRecord.Sleep
        assertEquals(listOf("STAGE_TYPE_DEEP", "STAGE_TYPE_LIGHT"), sleep.stages.map { it.stageType })
    }
}
