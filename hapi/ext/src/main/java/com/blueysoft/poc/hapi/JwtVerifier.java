package com.blueysoft.poc.hapi;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.KeySourceException;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.proc.BadJOSEException;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.proc.BadJWTException;
import com.nimbusds.jwt.proc.DefaultJWTClaimsVerifier;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import java.text.ParseException;
import java.util.List;
import java.util.Set;

/**
 * Verifies an access token: signature against the realm's published keys, then {@code iss}, {@code aud},
 * {@code exp} (and {@code nbf} if present), then returns the roles. Nothing in a token is believed before
 * the signature has verified.
 *
 * <p>Fixed choices, each of which closes a known attack:
 * <ul>
 *   <li>Only RS256 is accepted (what the realm signs with). {@code alg: none}, HMAC (the "use the public key
 *       as the HMAC secret" confusion attack) and every other algorithm are rejected.</li>
 *   <li>The key is selected from the realm's JWKS by {@code kid}; the token cannot name a key location.</li>
 *   <li>{@code exp} is mandatory; the clock skew allowance is {@link #CLOCK_SKEW_SECONDS}.</li>
 * </ul>
 */
public class JwtVerifier {

	/** Tolerance for clock difference between Keycloak and this container (both use the host clock via Docker). */
	public static final int CLOCK_SKEW_SECONDS = 30;

	private final DefaultJWTProcessor<SecurityContext> myProcessor = new DefaultJWTProcessor<>();

	public JwtVerifier(JWKSource<SecurityContext> theKeys, String theIssuer, String theAudience) {
		myProcessor.setJWSKeySelector(new JWSVerificationKeySelector<>(JWSAlgorithm.RS256, theKeys));
		DefaultJWTClaimsVerifier<SecurityContext> claims = new DefaultJWTClaimsVerifier<>(
				theAudience,
				new JWTClaimsSet.Builder().issuer(theIssuer).build(), // exact match on iss
				Set.of("exp", "iss", "aud", "sub"));
		claims.setMaxClockSkew(CLOCK_SKEW_SECONDS);
		myProcessor.setJWTClaimsSetVerifier(claims);
	}

	/** Returns the verified token's roles ({@code roles} claim, a flat string array); empty if absent. */
	public VerifiedToken verify(String theBearerToken) throws JwtRejectedException, KeySourceUnavailableException {
		JWTClaimsSet claims;
		try {
			claims = myProcessor.process(theBearerToken, null);
		} catch (ParseException e) {
			throw new JwtRejectedException("not a parseable JWT", e);
		} catch (BadJWTException e) {
			throw new JwtRejectedException("claims rejected: " + e.getMessage(), e);
		} catch (BadJOSEException e) {
			throw new JwtRejectedException("signature/header rejected: " + e.getMessage(), e);
		} catch (KeySourceException e) {
			throw new KeySourceUnavailableException("signing keys unavailable: " + e.getMessage(), e);
		} catch (JOSEException e) {
			throw new JwtRejectedException("verification failed: " + e.getMessage(), e);
		}
		List<String> roles;
		try {
			List<String> claimed = claims.getStringListClaim("roles");
			roles = claimed == null ? List.of() : List.copyOf(claimed);
		} catch (ParseException e) {
			throw new JwtRejectedException("roles claim is not a string array", e);
		}
		return new VerifiedToken(claims.getSubject(), azp(claims), roles);
	}

	private static String azp(JWTClaimsSet theClaims) throws JwtRejectedException {
		try {
			return theClaims.getStringClaim("azp");
		} catch (ParseException e) {
			throw new JwtRejectedException("azp claim is not a string", e);
		}
	}

	/** What the rest of the code may rely on: it all came from a token whose signature verified. */
	public record VerifiedToken(String subject, String authorizedParty, List<String> roles) {}
}
