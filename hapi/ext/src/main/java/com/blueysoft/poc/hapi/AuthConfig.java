package com.blueysoft.poc.hapi;

import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.proc.SecurityContext;
import java.net.URL;
import java.nio.file.Path;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/** Builds the one {@link JwtVerifier}. Configuration comes from the {@code poc.auth.*} keys in hapi/application.yaml. */
@Configuration
public class AuthConfig {

	private static final Logger ourLog = LoggerFactory.getLogger(AuthConfig.class);

	/**
	 * Fails startup (closed) if the CA file or the URL is unusable. The identity provider itself need not be up
	 * yet: keys are fetched on first use.
	 */
	@Bean
	public JwtVerifier jwtVerifier(
			@Value("${poc.auth.issuer}") String theIssuer,
			@Value("${poc.auth.jwks-uri}") String theJwksUri,
			@Value("${poc.auth.audience}") String theAudience,
			@Value("${poc.auth.ca-file}") String theCaFile)
			throws Exception {
		if (!theJwksUri.startsWith("https://")) {
			throw new IllegalArgumentException("poc.auth.jwks-uri must be https");
		}
		// cache 5 min; one refresh at a time (15 s timeout); an unknown kid triggers a refetch, rate-limited to 1 per 30 s
		JWKSource<SecurityContext> keys = JWKSourceBuilder.<SecurityContext>create(
						new URL(theJwksUri), new CaTrustResourceRetriever(Path.of(theCaFile)))
				.cache(300_000L, 15_000L)
				.rateLimited(30_000L)
				.retrying(true)
				.build();
		ourLog.info("Token verification active: issuer={} audience={} jwks={} (RS256 only)", theIssuer, theAudience, theJwksUri);
		return new JwtVerifier(keys, theIssuer, theAudience);
	}
}
