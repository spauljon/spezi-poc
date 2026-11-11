package com.aboutobjects.healthgate.probe

import android.graphics.Typeface
import android.os.Bundle
import android.util.Log
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import java.time.Duration
import java.time.Instant

/**
 * M24 probe. Reads Health Connect and shows structure only: counts, app package names, which optional
 * fields exist. It never shows or logs a value, a food name or a title. The only log call in the
 * project is the one in [show], and it logs the finished aggregate text (debug builds only).
 */
class MainActivity : ComponentActivity() {
    private lateinit var output: TextView
    private val changes by lazy { ChangesProbe(this) }
    private val ledger by lazy { IdLedger(this) }

    private val requestPermissions = registerForActivityResult(
        PermissionController.createRequestPermissionResultContract(),
    ) { granted ->
        show("Granted ${granted.size} of ${ProbeTypes.readPermissions.size} read permissions.")
    }

    private fun client(): HealthConnectClient? {
        val status = HealthConnectClient.getSdkStatus(this)
        if (status != HealthConnectClient.SDK_AVAILABLE) {
            show("Health Connect is not available (SDK status $status).")
            return null
        }
        return HealthConnectClient.getOrCreate(this)
    }

    private fun show(text: String) {
        output.text = text
        if (BuildConfig.DEBUG) Log.i("HealthGateProbe", text)
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick() }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        output = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 11f
            setTextIsSelectable(true)
        }
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 96, 24, 24)
            addView(button("1. Check Health Connect") {
                client()?.let { show("Health Connect is available.") }
            })
            addView(button("2. Request read permissions") {
                if (client() != null) requestPermissions.launch(ProbeTypes.readPermissions)
            })
            addView(button("3. Read the last 30 days (counts only)") { readAll() })
            addView(button("4. Take a changes token") {
                lifecycleScope.launch { client()?.let { show(changes.takeToken(it)) } }
            })
            addView(button("5. Read changes since the token") {
                lifecycleScope.launch { client()?.let { show(changes.readChanges(it)) } }
            })
            addView(button("6. Check the network (HAPI, TLS trust)") {
                lifecycleScope.launch { show(NetworkProbe().check()) }
            })
            addView(output)
        }
        setContentView(
            ScrollView(this).apply {
                addView(
                    column,
                    ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
                )
            },
        )
        show("Probe ready. Counts and field names only; no values are shown or logged.")
    }

    private fun readAll() {
        val client = client() ?: return
        lifecycleScope.launch {
            val granted = client.permissionController.getGrantedPermissions()
            val since = Instant.now().minus(Duration.ofDays(30))
            val reports = ProbeTypes.all.map { type ->
                if (type.readPermission !in granted) {
                    Aggregate.report(type.label, permitted = false, records = emptyList(), capped = false)
                } else {
                    val (records, capped) = ProbeTypes.read(client, type, since)
                    val previous = ledger.previous(type.label)
                    ledger.remember(type.label, records.map { it.idHash })
                    Aggregate.report(type.label, permitted = true, records = records, capped = capped, previousIds = previous)
                }
            }
            show(ReportFormatter.format(reports, "Last 30 days, read at ${Instant.now()}"))
        }
    }
}
