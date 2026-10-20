package com.aboutobjects.poc.hapi;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.server.interceptor.auth.PolicyEnum;
import java.util.List;
import org.hl7.fhir.r4.model.IdType;
import org.hl7.fhir.r4.model.Observation;
import org.junit.jupiter.api.Test;

/** The rule that carries a retraction through HAPI's checks: an Observation PATCH or UPDATE, nothing else. */
class RetractionRuleTest {

	private final RetractionRule rule = new RetractionRule();

	private PolicyEnum verdict(RestOperationTypeEnum op, String id) {
		var v = rule.applyRule(op, null, null, id == null ? null : new IdType(id), null, null, null, null);
		return v == null ? null : v.getDecision();
	}

	@Test
	void allowsAnObservationPatchAndTheUpdateItProduces_theControl() {
		assertEquals(PolicyEnum.ALLOW, verdict(RestOperationTypeEnum.PATCH, "Observation/abc"));
		assertEquals(PolicyEnum.ALLOW, verdict(RestOperationTypeEnum.UPDATE, "Observation/abc"));
	}

	@Test
	void givesNoVerdictForAnythingElse() {
		assertNull(verdict(RestOperationTypeEnum.PATCH, "Patient/abc"));
		assertNull(verdict(RestOperationTypeEnum.UPDATE, "Device/abc"));
		assertNull(verdict(RestOperationTypeEnum.PATCH, null));
		for (var other : List.of(RestOperationTypeEnum.DELETE, RestOperationTypeEnum.CREATE, RestOperationTypeEnum.READ,
				RestOperationTypeEnum.SEARCH_TYPE, RestOperationTypeEnum.TRANSACTION)) {
			assertNull(verdict(other, "Observation/abc"), other.name());
		}
		// a response being shown is not a write
		assertNull(rule.applyRule(RestOperationTypeEnum.UPDATE, null, null, new IdType("Observation/abc"), new Observation(), null, null, null));
	}

	@Test
	void isInTheRulesOnlyWhenARetractionWasAccepted() {
		var roles = List.of("capture-writer");
		var without = PocAuthorizationInterceptor.rulesFor(roles);
		var with = PocAuthorizationInterceptor.rulesFor(roles, true);
		assertEquals(without.size() + 1, with.size());
		assertEquals(false, without.stream().anyMatch(r -> r instanceof RetractionRule));
		assertEquals(true, with.stream().anyMatch(r -> r instanceof RetractionRule));
		assertEquals(false, with.get(with.size() - 1) instanceof RetractionRule); // the final deny stays last
		assertEquals(false, PocAuthorizationInterceptor.rulesFor(List.of("clinician-reader"), true).stream().anyMatch(r -> r instanceof RetractionRule));
	}
}
