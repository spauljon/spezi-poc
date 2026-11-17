package com.aboutobjects.poc.hapi;

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
 * Allows the authorization checks HAPI makes for an Observation update or delete inside a transaction. Like
 * {@link RetractionRule} it is added to a request's rules ONLY after {@link ChangePolicy} has accepted every PUT and
 * DELETE entry of that request's Bundle; it is in no role's normal rules, so a direct PUT or DELETE never sees it.
 * Even then it allows nothing but an UPDATE or DELETE of an Observation; anything else gets no verdict and falls
 * through to the final deny.
 */
final class ChangeRule implements IAuthRule {

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
		if (theOperation != RestOperationTypeEnum.UPDATE && theOperation != RestOperationTypeEnum.DELETE) {
			return null;
		}
		// HAPI passes the existing resource as the "output" when it checks an update or delete of it, so a resource there is
		// not a response being shown; the operation is what is matched (never a READ or SEARCH).
		if (!"Observation".equals(typeOf(theInputResource, theInputResourceId, theOutputResource, theRequestDetails))) {
			return null;
		}
		return new Verdict(PolicyEnum.ALLOW, this);
	}

	private static String typeOf(IBaseResource theResource, IIdType theId, IBaseResource theOutput, RequestDetails theRequest) {
		IBaseResource resource = theResource != null ? theResource : theOutput;
		if (resource != null && theRequest != null) {
			return theRequest.getFhirContext().getResourceType(resource);
		}
		if (resource != null) {
			return resource.fhirType();
		}
		return theId == null ? null : theId.getResourceType();
	}

	@Override
	public String getName() {
		return "change-own-health-connect-observation";
	}
}
