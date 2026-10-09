package com.blueysoft.poc.hapi;

import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Interceptor;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.RequestTypeEnum;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.exceptions.AuthenticationException;
import ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException;
import ca.uhn.fhir.rest.server.interceptor.auth.AuthorizationInterceptor;
import ca.uhn.fhir.rest.server.interceptor.auth.IAuthRule;
import ca.uhn.fhir.rest.server.interceptor.auth.PolicyEnum;
import ca.uhn.fhir.rest.server.interceptor.auth.RuleBuilder;
import jakarta.annotation.Nonnull;
import java.util.List;
import org.hl7.fhir.r4.model.Observation;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Authentication and authorization in one HAPI interceptor, moved EARLIER in the request lifecycle.
 *
 * <p>HAPI itself does not authenticate: {@link AuthorizationInterceptor} only evaluates rules. This subclass
 * verifies the bearer token ({@link JwtVerifier}) and builds rules from its roles. Default policy is DENY, so a
 * role this class does not know grants nothing.
 *
 * <p><b>Why it hooks {@code SERVER_INCOMING_REQUEST_POST_PROCESSED} at order -1.</b> The stock hook runs at
 * {@code SERVER_INCOMING_REQUEST_PRE_HANDLED}, after {@code RequestValidatingInterceptor}
 * ({@code POST_PROCESSED}, order 0). With request validation on, an anonymous caller who POSTs a single resource
 * that fails validation gets 422 and the validator's findings instead of 401 (reproduced against 7.6.0). Running
 * this check first, at order -1, answers 401 before any validation. The pattern (move the parent's
 * {@code incomingRequestPreHandled} left, and make the original hook a no-op) is the one used in production in
 * the VA smart-pgd-fhir-service; see hapi/README.md.
 *
 * <p>The only anonymous request is {@code GET [base]/metadata}; a token that is PRESENT must be valid even there.
 *
 * <p>Discovered via {@code hapi.fhir.custom-bean-packages} and registered via
 * {@code hapi.fhir.custom-interceptor-classes} (hapi/application.yaml).
 */
@Interceptor
@Component
public class PocAuthorizationInterceptor extends AuthorizationInterceptor {

	private static final Logger ourLog = LoggerFactory.getLogger(PocAuthorizationInterceptor.class);

	static final String ROLE_CAPTURE = "capture-writer";
	static final String ROLE_CLINICIAN = "clinician-reader";
	static final String ROLE_WORKER = "worker-reader";

	private final JwtVerifier myVerifier;

	public PocAuthorizationInterceptor(JwtVerifier theVerifier) {
		super(PolicyEnum.DENY);
		myVerifier = theVerifier;
	}

	/** Authorization shifted left: runs before the request validator (order 0). Failures throw (401/403/503). */
	@Hook(value = Pointcut.SERVER_INCOMING_REQUEST_POST_PROCESSED, order = -1)
	public boolean incomingRequestPostProcessed(@Nonnull RequestDetails theRequest) {
		super.incomingRequestPreHandled(theRequest, Pointcut.SERVER_INCOMING_REQUEST_POST_PROCESSED);
		return true;
	}

	/** The parent's work already ran above; running it again at PRE_HANDLED would verify the token twice. */
	@Override
	public void incomingRequestPreHandled(@Nonnull RequestDetails theRequest, @Nonnull Pointcut thePointcut) {
		ourLog.trace("authorization already ran at POST_PROCESSED");
	}

	@Override
	public List<IAuthRule> buildRuleList(RequestDetails theRequest) {
		String header = theRequest.getHeader("Authorization");

		if (header == null) {
			if (isCapabilityStatement(theRequest.getRequestType(), theRequest.getRequestPath(), theRequest.getRestOperationType())) {
				return new RuleBuilder().allow().metadata().andThen().denyAll().build();
			}
			throw unauthorized("no Authorization header");
		}
		String token = bearerToken(header);
		if (token == null) {
			throw unauthorized("Authorization header is not 'Bearer <token>'");
		}

		JwtVerifier.VerifiedToken verified;
		try {
			verified = myVerifier.verify(token);
		} catch (JwtRejectedException e) {
			throw unauthorized(e.getMessage());
		} catch (KeySourceUnavailableException e) {
			ourLog.error("Cannot verify tokens, rejecting request: {}", e.getMessage());
			throw new UnclassifiedServerFailureException(503, "Authentication service unavailable");
		}

		List<IAuthRule> rules = rulesFor(verified.roles());
		ourLog.debug("Authenticated azp={} roles={} -> {} rule(s)", verified.authorizedParty(), verified.roles(), rules.size());
		return rules;
	}

	/** Roles to rules. Pure function of the verified roles. */
	static List<IAuthRule> rulesFor(List<String> theRoles) {
		RuleBuilder b = new RuleBuilder();
		boolean any = false;

		if (theRoles.contains(ROLE_CAPTURE)) {
			// create + read (search is a read) on the three types the capture app writes; no update/delete
			for (String type : List.of("Observation", "Device", "Patient")) {
				b.allow().create().resourcesOfType(type).withAnyId().andThen();
				b.allow().read().resourcesOfType(type).withAnyId().andThen();
			}
			any = true;
		}
		if (theRoles.contains(ROLE_CLINICIAN) || theRoles.contains(ROLE_WORKER)) {
			b.allow().read().allResources().withAnyId().andThen();
			// $lastn is a read-only, type-level operation on Observation
			b.allow().operation().named("$lastn").onType(Observation.class).andAllowAllResponses().andThen();
			any = true;
		}
		if (any) {
			b.allow().metadata().andThen();
		}
		return b.denyAll().build();
	}

	/** The capability statement: GET [base]/metadata. */
	static boolean isCapabilityStatement(RequestTypeEnum theType, String thePath, RestOperationTypeEnum theOperation) {
		return theType == RequestTypeEnum.GET && ("metadata".equals(thePath) || theOperation == RestOperationTypeEnum.METADATA);
	}

	/** Returns the token from exactly "Bearer <token>" (scheme case-insensitive, RFC 7235), else null. */
	static String bearerToken(String theHeader) {
		if (theHeader == null) {
			return null;
		}
		String[] parts = theHeader.trim().split("\\s+");
		return parts.length == 2 && parts[0].equalsIgnoreCase("Bearer") ? parts[1] : null;
	}

	/** The client learns only that authentication failed; the reason goes to the log (never the token). */
	private static AuthenticationException unauthorized(String theLogReason) {
		ourLog.warn("401: {}", theLogReason);
		AuthenticationException e = new AuthenticationException("Authentication required");
		e.addResponseHeader("WWW-Authenticate", "Bearer realm=\"poc-fhir\"");
		return e;
	}
}
