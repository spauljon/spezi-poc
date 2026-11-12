package com.aboutobjects.healthgate.sync

/** FHIR search syntax for the queries the app makes. */
object FhirSearch {
    /** `identifier=<system>|<value>` with the FHIR token escapes (`\`, `,`, `|`, `$`) and then percent-encoding. */
    fun identifierQuery(system: String, value: String): String = "identifier=" + percentEncode("${escapeToken(system)}|${escapeToken(value)}")

    fun escapeToken(value: String): String = buildString {
        for (c in value) {
            if (c == '\\' || c == ',' || c == '|' || c == '$') append('\\')
            append(c)
        }
    }

    /** Percent-encodes every byte of the UTF-8 text except the unreserved set, so `|` and `#` are always encoded. */
    fun percentEncode(value: String): String = buildString {
        for (b in value.toByteArray(Charsets.UTF_8)) {
            val c = b.toInt() and 0xff
            if (c in 'A'.code..'Z'.code || c in 'a'.code..'z'.code || c in '0'.code..'9'.code || c == '-'.code || c == '.'.code || c == '_'.code || c == '~'.code) {
                append(c.toChar())
            } else {
                append("%%%02X".format(java.util.Locale.ROOT, c))
            }
        }
    }
}
