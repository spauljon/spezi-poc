package com.aboutobjects.healthgate.probe

import java.net.InetAddress
import org.json.JSONObject
import java.net.URL
import java.security.KeyStore
import java.security.cert.CertPathValidatorException
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Checks the road to the developer's own HAPI: name resolution, then TLS trust, with an anonymous GET of
 * /fhir/metadata (the only anonymous endpoint). It reads no patient data and reports only status, sizes,
 * times and exception class names.
 */
class NetworkProbe(private val host: String = "macpro16.local", private val hapiPort: Int = 8443, private val idpPort: Int = 8444) {
    private class Reply(val status: Int, val bytes: Int, val millis: Long, val text: String?)

    suspend fun check(): String = withContext(Dispatchers.IO) {
        buildString {
            appendLine("== Network check: $host (HAPI :$hapiPort, IdP edge :$idpPort)")
            val addresses = try {
                InetAddress.getAllByName(host).map { it.hostAddress }
            } catch (e: Exception) {
                appendLine("  resolve: failed (${e.javaClass.simpleName})")
                return@buildString
            }
            appendLine("  resolve: ${addresses.joinToString()}")

            val hapi = "https://$host:$hapiPort/fhir/metadata"
            appendLine("  HAPI metadata, app trust (debug network security config): ${describe { fetch(hapi, null, false) }}")
            appendLine("  HAPI metadata, system CAs only (control, must be rejected as untrusted): ${describe { fetch(hapi, systemOnlyFactory(), false) }}")

            val realm = "https://$host:$idpPort/realms/poc"
            appendLine("  IdP discovery: ${describe { fetch("$realm/.well-known/openid-configuration", null, true) }}")
            val issuer = try {
                JSONObject(fetch("$realm/.well-known/openid-configuration", null, true).text ?: "{}").optString("issuer")
            } catch (e: Exception) {
                ""
            }
            appendLine("  discovery issuer matches the URL the app would use: ${issuer == realm} ($issuer)")
            appendLine("  IdP key set: ${describe { fetch("$realm/protocol/openid-connect/certs", null, false) }}")
            appendLine("  IdP master realm (control, the edge must answer 404): ${describe { fetch("https://$host:$idpPort/realms/master/.well-known/openid-configuration", null, false) }}")
            appendLine("  IdP discovery, system CAs only (control, must be rejected as untrusted): ${describe { fetch("$realm/.well-known/openid-configuration", systemOnlyFactory(), false) }}")
        }
    }

    /** A socket factory that trusts only the platform's CA store, ignoring the app's network security config. */
    private fun systemOnlyFactory(): SSLSocketFactory {
        val store = KeyStore.getInstance("AndroidCAStore").apply { load(null) }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
        return SSLContext.getInstance("TLS").apply { init(null, tmf.trustManagers, null) }.socketFactory
    }

    /** GET [url]; keeps the body text only when [keepText] (public configuration documents, never patient data). */
    private fun fetch(url: String, factory: SSLSocketFactory?, keepText: Boolean): Reply {
        val started = System.nanoTime()
        val c = (URL(url).openConnection() as HttpsURLConnection).apply {
            connectTimeout = 5_000
            readTimeout = 8_000
            if (factory != null) sslSocketFactory = factory
        }
        val status = c.responseCode
        val stream = if (status in 200..299) c.inputStream else c.errorStream
        val data = stream?.use { it.readBytes() } ?: ByteArray(0)
        val millis = (System.nanoTime() - started) / 1_000_000
        return Reply(status, data.size, millis, if (keepText) String(data) else null)
    }

    private fun describe(call: () -> Reply): String = try {
        val r = call()
        "HTTP ${r.status}, ${r.bytes} bytes, ${r.millis} ms"
    } catch (e: Exception) {
        val chain = generateSequence<Throwable>(e) { it.cause }.toList()
        "failed: ${chain.joinToString(" <- ") { it.javaClass.simpleName }}" +
            if (chain.any { it is CertPathValidatorException }) " (certificate chain not trusted)" else ""
    }
}
