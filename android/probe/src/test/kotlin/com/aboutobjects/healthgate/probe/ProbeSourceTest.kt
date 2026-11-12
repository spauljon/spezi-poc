package com.aboutobjects.healthgate.probe

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The probe handles the developer's real Health Connect data, so no source may log or print except the one allowed call. */
class ProbeSourceTest {
    private val dir = File("src/main/kotlin/com/aboutobjects/healthgate/probe")
    private val forbidden = Regex("""\b(Log\.[a-z]+|println|print|printStackTrace|Timber)\s*\(""")

    private fun offenders(files: List<File>) =
        files.filter { forbidden.containsMatchIn(it.readText()) }.map { it.name }.sorted()

    @Test fun onlyMainActivityLogs() {
        val files = dir.listFiles { f -> f.extension == "kt" }!!.toList()
        assertTrue("sources found", files.size >= 6)
        assertEquals(listOf("MainActivity.kt"), offenders(files))
    }

    @Test fun mainActivityHasExactlyOneLogCallAndItIsDebugOnly() {
        val text = File(dir, "MainActivity.kt").readText()
        assertEquals(1, Regex("""Log\.""").findAll(text).count())
        assertTrue(text.contains("if (BuildConfig.DEBUG) Log.i"))
    }

    @Test fun theDetectorSeesALog() {
        val probe = File.createTempFile("probe", ".kt").apply { writeText("fun f() { Log.i(\"t\", x) }"); deleteOnExit() }
        assertEquals(1, offenders(listOf(probe)).size)
    }

    @Test fun recordSummaryHasNoFieldThatCanHoldAValue() {
        val names = RecordSummary::class.java.declaredFields.map { it.name }.toSet()
        val allowed = setOf(
            "origin", "startMs", "endMs", "hasClientRecordId", "hasStartOffset", "hasEndOffset", "hasDevice",
            "updatedAfterEnd", "recordingMethod", "samples", "fields", "idHash", "mealType", "startHour",
        )
        assertEquals(allowed, names)
    }
}
