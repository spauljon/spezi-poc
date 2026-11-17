package com.aboutobjects.healthgate.healthconnect

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The real data's rules, enforced where they can be: the code that touches Health Connect records never logs (so a value cannot reach a
 * log), never reads a clock itself in the pure mapper, and asks only for read permissions. Each scan has its control.
 */
class HealthConnectSourceTest {
    private val dir = File("src/main/kotlin/com/aboutobjects/healthgate/ingest/healthconnect")
    private val files = dir.listFiles { f -> f.extension == "kt" }!!.toList()

    private val logging = Regex("""\b(Log\.[a-z]+|println|print|printStackTrace|Timber)\s*\(""")
    private val clock = Regex("""Instant\.now\(|System\.currentTimeMillis|Clock\.|LocalDate(Time)?\.now|ZoneId\.systemDefault|Math\.random|Random\(""")

    @Test fun nothingThatReadsHealthConnectRecordsLogs() {
        assertTrue("sources found: ${files.map { it.name }}", files.size >= 5)
        assertEquals(emptyList<String>(), files.filter { logging.containsMatchIn(it.readText()) }.map { it.name })
        assertTrue("control", logging.containsMatchIn("fun f(v: Double) { Log.d(\"x\", \"\$v\") }"))
        assertTrue("control", logging.containsMatchIn("println(record)"))
    }

    @Test fun theMapperIsAPureFunctionOfItsInputs() {
        val mapper = files.single { it.name == "HealthConnectMapper.kt" }.readText()
        assertEquals(emptyList<String>(), clock.findAll(mapper).map { it.value }.toList())
        assertTrue("control", clock.containsMatchIn("val t = Instant.now()"))
        assertTrue("control", clock.containsMatchIn("ZoneId.systemDefault()"))
    }

    @Test fun theAppAsksForReadPermissionsOnlyAndTheCollectorNeverWritesToHealthConnect() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val pattern = Regex("""<uses-permission android:name="android\.permission\.health\.([A-Z_]+)"""")
        val health = pattern.findAll(manifest).map { it.groupValues[1] }.toList()
        assertEquals(6, health.size)
        assertTrue(health.all { it.startsWith("READ_") })
        assertTrue("control", pattern.findAll("""<uses-permission android:name="android.permission.health.WRITE_SLEEP" />""").any { !it.groupValues[1].startsWith("READ_") })
        val writes = Regex("""\b(insertRecords|updateRecords|deleteRecords)\b""")
        assertEquals(emptyList<String>(), files.filter { writes.containsMatchIn(it.readText()) }.map { it.name })
        assertTrue("control", writes.containsMatchIn("client.insertRecords(x)"))
    }
}
