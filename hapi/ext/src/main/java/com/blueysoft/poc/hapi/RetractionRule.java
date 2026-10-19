package com.blueysoft.poc.hapi;

import ca.uhn.fhir.interceptor.api.Pointcut;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.api.server.RequestDetails;
import ca.uhn.fhir.rest.server.interceptor.auth.AuthorizationFlagsEnum;
import ca.uhn.fhir.rest.server.interceptor.auth.AuthorizationInterceptor.Verdict;
import ca.uhn.fhir.rest.server.interceptor.auth.IAuthRule;
import ca.uhn.fhir.rest.server.interceptor.auth.IRuleApplier;
import ca.uhn.fhir.rest.server.interceptor.auth.PolicyEnum;
import java.util.Set;
import org.hl7.fhir.instance.model.api.IBaseResource;
import org.hl7.fhir.instance.model.api.IIdType;

/**
 * Allows the two authorization checks HAPI makes for one conditional JSON Patch of an Observation: the PATCH itself
 * and the UPDATE it produces. It exists because HAPI 7.6.0's own {@code allow().patch().allRequests()} only matches a
 * PATCH with no resource type, and a conditional patch ({@code PATCH /Observation?identifier=...}) always has one,
 * so that rule never fires (observed live: 403 for the accepted request).
 *
 * <p>It is added to a request's rule list ONLY after {@link RetractionPolicy} has shown the request to be the
 * permitted retraction (see {@code PocAuthorizationInterceptor.guardPatch}); it is not part of any role's normal rules, so
 * a PUT, a delete or any other PATCH never sees it. Even then it allows nothing but a PATCH or UPDATE of an
 * Observation. Anything else gets no verdict and falls through to the final deny.
 */
final class RetractionRule implements IAuthRule {

	@Override
	public Verdict applyRule(
			RestOperationTypeEnum theOperation,
			RequestDetails theRequestDetails,
			IBaseResource theInputResource,
			IIdType theInputResourceId,
			IBaseResource theOutputResource,
			IRuleApplier theRuleApplier,
			Set<AuthorizationFlagsEnum> theFlags,
			Pointcut thePointcut) {
		if (theOperation != RestOperationTypeEnum.PATCH && theOperation != RestOperationTypeEnum.UPDATE) {
			return null;
		}
		if (theOutputResource != null) {
			return null; // only the write side, never a response
		}
		if (!"Observation".equals(typeOf(theInputResource, theInputResourceId, theRequestDetails))) {
			return null;
		}
		return new Verdict(PolicyEnum.ALLOW, this);
	}

	private static String typeOf(IBaseResource theResource, IIdType theId, RequestDetails theRequest) {
		if (theResource != null) {
			return theRequest.getFhirContext().getResourceType(theResource);
		}
		return theId == null ? null : theId.getResourceType();
	}

	@Override
	public String getName() {
		return "retract-own-observation";
	}
}
