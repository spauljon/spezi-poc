package com.blueysoft.poc.hapi;

import com.nimbusds.jose.util.Resource;
import com.nimbusds.jose.util.ResourceRetriever;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.cert.Certificate;
import java.security.cert.CertificateFactory;
import java.time.Duration;
import javax.net.ssl.SSLContext;
import javax.net.ssl.TrustManagerFactory;

/**
 * Fetches the realm's JWKS over HTTPS, trusting ONLY the POC CA (read from a PEM file), with normal
 * certificate-chain and host-name verification. Using a private SSLContext instead of the JVM-wide
 * truststore means this trust decision cannot leak into, or be changed by, anything else in the process.
 * Redirects are never followed and the body is size-capped.
 */
public class CaTrustResourceRetriever implements ResourceRetriever {

	private static final int MAX_BYTES = 256 * 1024;

	private final HttpClient myClient;

	public CaTrustResourceRetriever(Path theCaPem) throws IOException, GeneralSecurityException {
		KeyStore trust = KeyStore.getInstance(KeyStore.getDefaultType());
		trust.load(null, null);
		try (InputStream in = Files.newInputStream(theCaPem)) {
			int i = 0;
			for (Certificate c : CertificateFactory.getInstance("X.509").generateCertificates(in)) {
				trust.setCertificateEntry("poc-ca-" + i++, c);
			}
			if (i == 0) {
				throw new GeneralSecurityException("no certificate found in " + theCaPem);
			}
		}
		TrustManagerFactory tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
		tmf.init(trust);
		SSLContext ctx = SSLContext.getInstance("TLS");
		ctx.init(null, tmf.getTrustManagers(), null);
		myClient = HttpClient.newBuilder()
				.sslContext(ctx)
				.followRedirects(HttpClient.Redirect.NEVER)
				.connectTimeout(Duration.ofSeconds(5))
				.build();
	}

	@Override
	public Resource retrieveResource(URL theUrl) throws IOException {
		HttpRequest req = HttpRequest.newBuilder(URI.create(theUrl.toString()))
				.timeout(Duration.ofSeconds(5))
				.header("Accept", "application/json")
				.GET()
				.build();
		try {
			HttpResponse<byte[]> rsp = myClient.send(req, HttpResponse.BodyHandlers.ofByteArray());
			if (rsp.statusCode() != 200) {
				throw new IOException("JWKS endpoint returned HTTP " + rsp.statusCode());
			}
			if (rsp.body().length > MAX_BYTES) {
				throw new IOException("JWKS response too large");
			}
			return new Resource(new String(rsp.body(), StandardCharsets.UTF_8), "application/json");
		} catch (InterruptedException e) {
			Thread.currentThread().interrupt();
			throw new IOException("interrupted fetching JWKS", e);
		}
	}
}
