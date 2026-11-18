package com.aboutobjects.healthgate

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The developer's own health data must never reach a log or a screen dump (root data rules). Enforced where it can be: the app's own
 * sources never log or print at all, and the debug-only control code logs only counts and words, never a sample, a record or a value.
 * Each scan has its control.
 */
class NoLoggingOfSamplesTest {
    private val logging = Regex("""\b(Log\.[a-z]+|println|print|printStackTrace|Timber)\s*\(""")
    private fun kotlinFiles(dir: String) = File(dir).walkTopDown().filter { it.extension == "kt" }.toList()

    @Test fun noMainSourceLogsOrPrintsAnything() {
        val main = kotlinFiles("src/main/kotlin")
        assertTrue("sources found: ${main.size}", main.size > 30)
        assertEquals(emptyList<String>(), main.filter { logging.containsMatchIn(it.readText()) }.map { it.path.substringAfter("kotlin/") })
        assertTrue("control", logging.containsMatchIn("""fun f(x: Any) { Log.i("t", x.toString()) }"""))
        assertTrue("control", logging.containsMatchIn("println(sample)"))
    }

    /** A log call in the debug-only code may name counts and words; an interpolated sample, record, item, measurement, nutrient or value may not. */
    private val leak = Regex("""\$\{?\s*[A-Za-z_.?!]*\b(sample|samples|item|items|record|measurement|nutrients|value|values|bpm|origin|device)\b(?!\s*[A-Za-z])""")

    @Test fun theDebugControlCodeLogsOnlyCountsAndWords() {
        val debug = kotlinFiles("src/debug/kotlin")
        assertTrue(debug.isNotEmpty())
        val logLines = debug.flatMap { f -> f.readLines().filter { it.contains("Log.i(") }.map { f.name to it } }
        assertTrue("there are log lines to check: ${logLines.size}", logLines.size >= 5)
        val offenders = logLines.filter { (_, line) -> leak.containsMatchIn(line.substringAfter("Log.i(")) }
        assertEquals(emptyList<Pair<String, String>>(), offenders)
        // controls: the pattern does see an interpolated sample or value, and does not object to a count
        assertTrue(leak.containsMatchIn("""Log.i(TAG, "got ${'$'}{sample.value}")"""))
        assertTrue(leak.containsMatchIn("""Log.i(TAG, "item ${'$'}item")"""))
        assertTrue(!leak.containsMatchIn("""Log.i(TAG, "queued ${'$'}{r.collected?.samplesQueued} records")"""))
    }

    @Test fun theWriterLogsOnlyTheSentenceTheScenarioReturns() {
        val writer = kotlinFiles("../writer/src/main/kotlin")
        val lines = writer.flatMap { f -> f.readLines().filter { it.contains("Log.i(") } }
        assertTrue(lines.isNotEmpty())
        assertEquals(emptyList<String>(), lines.filter { leak.containsMatchIn(it.substringAfter("Log.i(")) })
    }
}
