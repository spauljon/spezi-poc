package com.aboutobjects.healthgate.writer

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The writer is a write-only synthetic-data tool: it must never read Health Connect, use the network or log. The scan has its control. */
class WriterSourceTest {
    private val sources = File("src/main/kotlin").walkTopDown().filter { it.extension == "kt" }.toList()
    private val manifest = File("src/main/AndroidManifest.xml").readText()

    private val forbidden = listOf("readRecord", "readRecords", "getChanges", "getChangesToken", "aggregate(", "android.util.Log", "println(", "java.net", "okhttp")

    private fun offences(text: String) = forbidden.filter { text.contains(it) }

    @Test fun theWriterNeverReadsHealthConnectNorLogsNorUsesTheNetwork() {
        assertTrue("the sources were found", sources.size >= 2)
        for (f in sources) assertEquals(f.name, emptyList<String>(), offences(f.readText()))
        // the control: the scan does see each forbidden call
        for (bad in forbidden) assertTrue(bad, bad in offences("x $bad y"))
    }

    @Test fun theManifestAsksForWritePermissionsOnlyAndNoNetwork() {
        val pattern = Regex("""<uses-permission android:name="android\.permission\.([A-Za-z_.]+)"""")
        val perms = pattern.findAll(manifest).map { it.groupValues[1] }.toList()
        assertTrue(perms.isNotEmpty())
        assertTrue(perms.all { it.startsWith("health.WRITE_") })
        assertFalse(manifest.contains("INTERNET"))
        // the control: the pattern would see a read permission
        assertTrue(pattern.findAll("""<uses-permission android:name="android.permission.health.READ_HEART_RATE" />""").any { !it.groupValues[1].startsWith("health.WRITE_") })
    }
}
