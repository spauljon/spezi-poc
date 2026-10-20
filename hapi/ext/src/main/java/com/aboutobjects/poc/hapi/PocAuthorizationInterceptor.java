package com.aboutobjects.poc.hapi;

import ca.uhn.fhir.interceptor.api.Hook;
import ca.uhn.fhir.interceptor.api.Interceptor;
import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.parser.DataFormatException;
import ca.uhn.fhir.parser.IParser;
import ca.uhn.fhir.rest.api.EncodingEnum;
import ca.uhn.fhir.rest.api.RequestTypeEnum;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.RestfulServerUtils;
import ca.uhn.fhir.rest.server.exceptions.AuthenticationException;
import ca.uhn.fhir.rest.server.exceptions.ForbiddenOperationException;
import ca.uhn.fhir.rest.server.exceptions.InvalidRequestException;
import ca.uhn.fhir.rest.server.exceptions.UnclassifiedServerFailureException;
import ca.uhn.fhir.rest.server.interceptor.auth.AuthorizationInterceptor;
import ca.uhn.fhir.rest.server.interceptor.auth.IAuthRule;
import ca.uhn.fhir.rest.server.interceptor.auth.PolicyEnum;
import ca.uhn.fhir.rest.server.interceptor.auth.RuleBuilder;
import ca.uhn.fhir.rest.server.method.ResourceParameter;
import jakarta.annotation.Nonnull;
import java.util.ArrayList;
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
	private final RetractionPolicy myRetractionPolicy;

	public PocAuthorizationInterceptor(JwtVerifier theVerifier, RetractionPolicy theRetractionPolicy) {
		super(PolicyEnum.DENY);
		myVerifier = theVerifier;
		myRetractionPolicy = theRetractionPolicy;
	}

	private static final String RULES_KEY = PocAuthorizationInterceptor.class.getName() + ".rules";
	private static final String ROLES_KEY = PocAuthorizationInterceptor.class.getName() + ".roles";

	/**
	 * Authorization shifted left: runs before the request validator (order 0). Failures throw (401/403/503).
	 *
	 * <p>Order matters:
	 * <ol>
	 *   <li>Authenticate. A caller who cannot prove who they are never has a body parsed (that would be the
	 *       validator-before-authorization problem again).</li>
	 *   <li>Parse the body, for a transaction or batch ONLY. Their entries are authorized one by one
	 *       ({@code andApplyNormalRules}), which needs the entries in hand; single-resource requests are authorized by
	 *       type and operation and need no parsing here.</li>
	 *   <li>Evaluate the rules.</li>
	 * </ol>
	 */
	@Hook(value = Pointcut.SERVER_INCOMING_REQUEST_POST_PROCESSED, order = -1)
	public boolean incomingRequestPostProcessed(@Nonnull RequestDetails theRequest) {
		theRequest.getUserData().put(RULES_KEY, computeRules(theRequest)); // throws 401 / 503
		RestOperationTypeEnum operation = theRequest.getRestOperationType();
		if (operation == RestOperationTypeEnum.PATCH) {
			guardPatch(theRequest);
		}
		if ((operation == RestOperationTypeEnum.TRANSACTION || operation == RestOperationTypeEnum.BATCH)
				&& theRequest.getResource() == null) {
			parseBody(theRequest);
		}
		super.incomingRequestPreHandled(theRequest, Pointcut.SERVER_INCOMING_REQUEST_POST_PROCESSED);
		return true;
	}

	/**
	 * The rule list can allow PATCH but not look inside it, so for a caller allowed to patch at all (the capture role)
	 * the request must be exactly the permitted retraction ({@link RetractionPolicy}); anything else is a 403 before
	 * HAPI runs it. Other roles are refused by the rules (default deny) and are not inspected here.
	 */
	private void guardPatch(RequestDetails theRequest) {
		Object roles = theRequest.getUserData().get(ROLES_KEY);
		if (!(roles instanceof List<?> list) || !list.contains(ROLE_CAPTURE)) {
			return;
		}
		@SuppressWarnings("unchecked")
		List<String> verifiedRoles = (List<String>) roles;
		String refusal = myRetractionPolicy.refusal(
				theRequest.getRequestType(),
				theRequest.getResourceName(),
				theRequest.getId() == null ? null : theRequest.getId().getIdPart(),
				theRequest.getParameters(),
				theRequest.getHeader("Content-Type"),
				theRequest.loadRequestContents());
		if (refusal != null) {
			ourLog.warn("403 PATCH refused: {}", refusal);
			throw new ForbiddenOperationException("Not permitted");
		}
		// Only THIS request, already shown to be the retraction, gets the rule that allows the PATCH and the update it
		// produces; a PUT or a conditional update by the same caller is built from the normal rules and stays refused.
		theRequest.getUserData().put(RULES_KEY, rulesFor(verifiedRoles, true));
	}

	private static void parseBody(RequestDetails theRequest) {
		EncodingEnum encoding = RestfulServerUtils.determineRequestEncodingNoDefault(theRequest);
		IParser parser = encoding == EncodingEnum.XML
				? theRequest.getFhirContext().newXmlParser()
				: theRequest.getFhirContext().newJsonParser();
		try {
			theRequest.setResource(parser.parseResource(ResourceParameter.createRequestReader(theRequest)));
		} catch (DataFormatException e) {
			// Reached only after authentication, so this reveals nothing to an anonymous caller.
			throw new InvalidRequestException("The request body could not be parsed");
		}
	}

	/** The parent's work already ran above; running it again at PRE_HANDLED would verify the token twice. */
	@Override
	public void incomingRequestPreHandled(@Nonnull RequestDetails theRequest, @Nonnull Pointcut thePointcut) {
		ourLog.trace("authorization already ran at POST_PROCESSED");
	}

	@Override
	public List<IAuthRule> buildRuleList(RequestDetails theRequest) {
		Object cached = theRequest.getUserData().get(RULES_KEY);
		if (cached instanceof List<?>) {
			@SuppressWarnings("unchecked")
			List<IAuthRule> rules = (List<IAuthRule>) cached;
			return rules; // already authenticated by incomingRequestPostProcessed in this request
		}
		return computeRules(theRequest);
	}

	private List<IAuthRule> computeRules(RequestDetails theRequest) {
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

		theRequest.getUserData().put(ROLES_KEY, verified.roles());
		List<IAuthRule> rules = rulesFor(verified.roles());
		ourLog.debug("Authenticated azp={} roles={} -> {} rule(s)", verified.authorizedParty(), verified.roles(), rules.size());
		return rules;
	}

	/** Roles to rules. Pure function of the verified roles. */
	static List<IAuthRule> rulesFor(List<String> theRoles) {
		return rulesFor(theRoles, false);
	}

	/** @param theRetraction true only for a request already shown to be the permitted retraction (see guardPatch) */
	static List<IAuthRule> rulesFor(List<String> theRoles, boolean theRetraction) {
		RuleBuilder b = new RuleBuilder();
		boolean any = false;

		if (theRoles.contains(ROLE_CAPTURE)) {
			// create + read (search is a read) on the three types the capture app writes; no update/delete
			for (String type : List.of("Observation", "Device", "Patient")) {
				b.allow().create().resourcesOfType(type).withAnyId().andThen();
				b.allow().read().resourcesOfType(type).withAnyId().andThen();
			}
			// The capture app uploads in transaction Bundles (M8). Allowing the transaction itself grants nothing more:
			// "andApplyNormalRules" authorizes EVERY entry by the rules above, so a Bundle may only create or read
			// Observation, Device and Patient, and one entry outside that (an update, a delete, another type) makes the
			// whole Bundle 403.
			b.allow().transaction().withAnyOperation().andApplyNormalRules().andThen();
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
		List<IAuthRule> rules = new ArrayList<>(b.denyAll().build());
		if (theRetraction && theRoles.contains(ROLE_CAPTURE)) {
			// M21 (D2): only for a request RetractionPolicy has accepted (guardPatch). HAPI's patch rule cannot match a
			// conditional PATCH, so a rule of our own sits in front of the final deny; see RetractionRule.
			rules.add(rules.size() - 1, new RetractionRule());
		}
		return rules;
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
