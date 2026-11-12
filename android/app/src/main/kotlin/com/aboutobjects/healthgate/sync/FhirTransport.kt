package com.aboutobjects.healthgate.sync

import java.io.IOException
import java.time.Duration
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

data class FhirRequest(
    val method: String,
    /** Relative to the FHIR base, query included and already percent-encoded (for example `Patient?identifier=...`). */
    val path: String,
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null,
)

data class FhirResponse(val status: Int, val body: String = "")

/** The request could not be made or answered (offline, timeout, a TLS failure). The description never contains a token. */
class TransportFailure(val description: String) : Exception(description)

interface FhirTransport {
    /** [token] is sent as the bearer credential and is never logged. */
    suspend fun send(request: FhirRequest, token: String): FhirResponse
}

/** HTTPS to the FHIR base, through OkHttp (which also does PATCH, needed by the retraction of M27). TLS trust is the app's network security config. */
class OkHttpTransport(
    private val baseUrl: String,
    private val client: OkHttpClient = OkHttpClient.Builder()
        .callTimeout(Duration.ofSeconds(60)).connectTimeout(Duration.ofSeconds(15)).build(),
) : FhirTransport {
    private val fhirJson = "application/fhir+json".toMediaType()

    override suspend fun send(request: FhirRequest, token: String): FhirResponse = withContext(Dispatchers.IO) {
        val url = if (request.path.isEmpty()) baseUrl else "$baseUrl/${request.path}"
        val builder = try {
            Request.Builder().url(url)
        } catch (e: IllegalArgumentException) {
            throw TransportFailure("The request URL is not valid.")
        }
        builder.header("Accept", "application/fhir+json")
        builder.header("Authorization", "Bearer $token")
        for ((name, value) in request.headers) builder.header(name, value)
        builder.method(request.method, request.body?.toRequestBody(fhirJson))
        try {
            client.newCall(builder.build()).execute().use { response ->
                FhirResponse(response.code, response.body?.string() ?: "")
            }
        } catch (e: IOException) {
            // the class and a short message only: an exception's text can echo a URL, never a header
            throw TransportFailure("Network: ${e.javaClass.simpleName}${e.message?.let { ": ${it.take(120)}" } ?: ""}")
        }
    }
}
