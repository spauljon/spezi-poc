package com.aboutobjects.healthgate.config

/** Where the app talks to: the developer's own HAPI and Keycloak (no secret in here; the app is a public OAuth client). */
data class ServerConfiguration(
    val host: String,
    val fhirBase: String,
    val issuer: String,
    val clientId: String,
    val redirectUri: String,
    /** The Android persona's Patient identifier (contract: poc-android-01), created or found on first upload. */
    val patientIdentifier: String,
    /**
     * The developer's own Health Connect data goes to THIS patient and no other (M30). Blank means not configured: such samples are held
     * in the queue and never sent, in particular never filed under [patientIdentifier].
     */
    val realPatientIdentifier: String? = null,
) {
    init {
        require(fhirBase.startsWith("https://") && issuer.startsWith("https://")) { "the server must be reached over https (TLS only)" }
    }

    companion object {
        const val CLIENT_ID = "android-capture"
        const val REDIRECT_URI = "com.aboutobjects.healthgate.android:/oauth2redirect"
        const val PATIENT_IDENTIFIER = "poc-android-01"

        /** The POC stack's addresses on [host]: HAPI on 8443 under /fhir, the IdP edge on 8444 under /realms/poc. */
        const val REAL_PATIENT_IDENTIFIER = "poc-real-android"

        fun forHost(host: String, realPatient: String? = REAL_PATIENT_IDENTIFIER) = ServerConfiguration(
            host = host,
            fhirBase = "https://$host:8443/fhir",
            issuer = "https://$host:8444/realms/poc",
            clientId = CLIENT_ID,
            redirectUri = REDIRECT_URI,
            patientIdentifier = PATIENT_IDENTIFIER,
            realPatientIdentifier = realPatient?.trim()?.takeIf { it.isNotEmpty() },
        )
    }
}
