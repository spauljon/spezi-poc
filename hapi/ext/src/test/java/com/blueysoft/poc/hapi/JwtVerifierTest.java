package com.blueysoft.poc.hapi;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.JWSSigner;
import com.nimbusds.jose.KeySourceException;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jose.jwk.source.ImmutableJWKSet;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.PlainJWT;
import com.nimbusds.jwt.SignedJWT;
import java.util.Date;
import java.util.List;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * Every rejection test has a positive control: the SAME builder with the SAME key produces a token the
 * verifier accepts (see {@link #validTokenIsAccepted}); each negative case changes exactly ONE thing and
 * asserts the rejection reason, so a test cannot pass for the wrong reason (e.g. a bad key).
 * Tokens are synthetic and signed with throwaway keys generated here.
 */
class JwtVerifierTest {

	static final String ISS = "https://idp.example.test/realms/poc";
	static final String AUD = "hapi-fhir";

	static RSAKey key;
	static RSAKey otherKey;
	static JwtVerifier verifier;

	@BeforeAll
	static void setUp() throws Exception {
		key = new RSAKeyGenerator(2048).keyID("k1").generate();
		otherKey = new RSAKeyGenerator(2048).keyID("k1").generate(); // same kid, different key material
		verifier = new JwtVerifier(new ImmutableJWKSet<>(new JWKSet(key.toPublicJWK())), ISS, AUD);
	}

	static JWTClaimsSet.Builder good() {
		Date now = new Date();
		return new JWTClaimsSet.Builder()
				.issuer(ISS).audience(AUD).subject("synthetic-subject")
				.issueTime(now).expirationTime(new Date(now.getTime() + 600_000))
				.claim("azp", "synthetic-client")
				.claim("roles", List.of("capture-writer"));
	}

	static String sign(JWTClaimsSet claims, RSAKey k, String kid) throws Exception {
		SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).keyID(kid).type(JOSEObjectType.JWT).build(), claims);
		jwt.sign(new RSASSASigner(k));
		return jwt.serialize();
	}

	static String sign(JWTClaimsSet claims) throws Exception {
		return sign(claims, key, "k1");
	}

	static String reason(String token) {
		return assertThrows(JwtRejectedException.class, () -> verifier.verify(token)).getMessage();
	}

	@Test
	void validTokenIsAccepted() throws Exception { // the positive control for everything below
		JwtVerifier.VerifiedToken t = verifier.verify(sign(good().build()));
		assertEquals(List.of("capture-writer"), t.roles());
		assertEquals("synthetic-client", t.authorizedParty());
	}

	@Test
	void expiredTokenIsRejectedForExpiry() throws Exception {
		Date past = new Date(System.currentTimeMillis() - 3_600_000);
		String r = reason(sign(good().expirationTime(past).build()));
		assertTrue(r.contains("Expired"), r);
	}

	@Test
	void expiryWithinClockSkewIsAccepted() throws Exception {
		Date justPast = new Date(System.currentTimeMillis() - (JwtVerifier.CLOCK_SKEW_SECONDS - 10) * 1000L);
		verifier.verify(sign(good().expirationTime(justPast).build()));
	}

	@Test
	void expiryBeyondClockSkewIsRejected() throws Exception {
		Date past = new Date(System.currentTimeMillis() - (JwtVerifier.CLOCK_SKEW_SECONDS + 30) * 1000L);
		assertTrue(reason(sign(good().expirationTime(past).build())).contains("Expired"));
	}

	@Test
	void wrongAudienceIsRejectedForAudience() throws Exception {
		String r = reason(sign(good().audience("some-other-api").build()));
		assertTrue(r.contains("audience"), r);
	}

	@Test
	void wrongIssuerIsRejectedForIssuer() throws Exception {
		String r = reason(sign(good().issuer("https://evil.example/realms/poc").build()));
		assertTrue(r.contains("iss"), r);
	}

	@Test
	void missingExpiryIsRejected() throws Exception {
		JWTClaimsSet noExp = new JWTClaimsSet.Builder().issuer(ISS).audience(AUD).subject("s").build();
		assertTrue(reason(sign(noExp)).contains("exp"));
	}

	@Test
	void signatureFromAnotherKeyWithTheSameKidIsRejectedForSignature() throws Exception {
		String r = reason(sign(good().build(), otherKey, "k1"));
		assertTrue(r.toLowerCase().contains("signature"), r);
	}

	@Test
	void unknownKidIsRejected() throws Exception {
		String r = reason(sign(good().build(), key, "does-not-exist"));
		assertTrue(r.contains("no matching key"), r);
	}

	@Test
	void tamperedPayloadIsRejectedForSignature() throws Exception {
		String[] p = sign(good().build()).split("\\.");
		String evil = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
				good().claim("roles", List.of("capture-writer", "clinician-reader")).build().toString().getBytes());
		String r = reason(p[0] + "." + evil + "." + p[2]);
		assertTrue(r.toLowerCase().contains("signature"), r);
	}

	@Test
	void algNoneIsRejected() {
		String r = reason(new PlainJWT(good().build()).serialize());
		assertTrue(r.toLowerCase().contains("unsecured") || r.toLowerCase().contains("plain"), r);
	}

	@Test
	void hmacSignedWithThePublicKeyAsSecretIsRejected() throws Exception { // algorithm-confusion attack
		byte[] secret = key.toPublicJWK().toRSAPublicKey().getEncoded();
		secret = java.util.Arrays.copyOf(secret.length >= 32 ? secret : new byte[32], Math.max(secret.length, 32));
		JWSSigner hmac = new MACSigner(secret);
		SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.HS256).keyID("k1").build(), good().build());
		jwt.sign(hmac);
		String r = reason(jwt.serialize());
		assertTrue(r.contains("Another algorithm expected") || r.contains("no matching key"), r);
	}

	@Test
	void garbageIsRejectedAsUnparseable() {
		assertTrue(reason("not.a.jwt").contains("parse") || reason("not.a.jwt").contains("JWT"));
		assertTrue(reason("x").contains("parseable"));
	}

	@Test
	void absentRolesClaimGivesNoRoles() throws Exception {
		assertEquals(List.of(), verifier.verify(sign(good().claim("roles", null).build())).roles());
	}

	@Test
	void identityProviderOutageIsNotAClientError() throws Exception {
		JWKSource<SecurityContext> down = (selector, ctx) -> { throw new KeySourceException("idp unreachable"); };
		JwtVerifier v = new JwtVerifier(down, ISS, AUD);
		assertInstanceOf(KeySourceUnavailableException.class,
				assertThrows(KeySourceUnavailableException.class, () -> v.verify(sign(good().build()))));
	}
}
