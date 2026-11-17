package com.aboutobjects.healthgate.writer

import android.content.Context
import android.os.Bundle
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContract
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeartRateVariabilityRmssdRecord
import androidx.health.connect.client.records.HydrationRecord
import androidx.health.connect.client.records.NutritionRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/** A test tool: buttons that write, change and delete SYNTHETIC Health Connect records. Plain views on purpose (no extra packages). */
class MainActivity : ComponentActivity() {
    private val permissions = setOf(
        HeartRateRecord::class, RestingHeartRateRecord::class, HeartRateVariabilityRmssdRecord::class, SleepSessionRecord::class, NutritionRecord::class, HydrationRecord::class,
    ).map { HealthPermission.getWritePermission(it) }.toSet()

    private lateinit var status: TextView
    private var scenarios: Scenarios? = null

    private val request = registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
        status.text = if (granted.containsAll(permissions)) "Write access granted." else "Write access was not granted for every type."
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences("writer_ids", Context.MODE_PRIVATE)
        val book = object : IdBook {
            override fun get(name: String) = prefs.getString(name, null)
            override fun put(name: String, id: String) { prefs.edit().putString(name, id).commit() }
            override fun remove(name: String) { prefs.edit().remove(name).commit() }
            override fun names() = prefs.all.keys.toSet()
        }
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(32, 96, 32, 48) }
        status = TextView(this).apply { text = "Synthetic records only. Nothing here is read."; textSize = 16f }
        column.addView(status)

        if (HealthConnectClient.getSdkStatus(this) != HealthConnectClient.SDK_AVAILABLE) {
            status.text = "Health Connect is not available on this phone."
            setContentView(ScrollView(this).apply { addView(column) })
            return
        }
        val client = HealthConnectClient.getOrCreate(this)
        val s = Scenarios(client, book).also { scenarios = it }

        fun action(label: String, block: suspend () -> String) {
            column.addView(Button(this).apply {
                text = label
                isAllCaps = false
                setOnClickListener {
                    lifecycleScope.launch {
                        status.text = try { block() } catch (e: Exception) { "Failed: ${e.javaClass.simpleName}" }
                    }
                }
            })
        }
        column.addView(Button(this).apply { text = "Allow writing"; isAllCaps = false; setOnClickListener { request.launch(permissions) } })
        action("Heart rate: write a record (3 samples)", s::heartRateWrite)
        action("Heart rate: add 2 samples to it (it grows)", s::heartRateGrow)
        action("Heart rate: change its first sample", s::heartRateChangeFirst)
        action("Heart rate: delete the record", s::heartRateDelete)
        action("Heart rate: write a LARGE record (5,000 samples)", s::heartRateLarge)
        action("Heart rate: delete the large record", s::heartRateLargeDelete)
        action("Resting heart rate: write", s::restingWrite)
        action("Resting heart rate: delete", s::restingDelete)
        action("HRV (RMSSD): write", s::hrvWrite)
        action("HRV (RMSSD): delete", s::hrvDelete)
        action("Hydration: write 250 mL", s::hydrationWrite)
        action("Hydration: delete", s::hydrationDelete)
        action("Sleep: write a session with 4 stages", s::sleepWrite)
        action("Sleep: delete", s::sleepDelete)
        action("Lunch: write (7 nutrients)", s::mealWrite)
        action("Lunch: re-create it (what MyFitnessPal does on every sync)", s::mealRecreate)
        action("Lunch: edit it (a different protein amount)", s::mealEdit)
        action("Lunch: delete", s::mealDelete)
        action("Delete everything this tool wrote", s::deleteAll)
        setContentView(ScrollView(this).apply { addView(column) })
    }
}
