package com.aboutobjects.poc.hapi;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import ca.uhn.fhir.rest.server.interceptor.auth.PolicyEnum;
import java.util.List;
import org.hl7.fhir.r4.model.IdType;
import org.junit.jupiter.api.Test;

/** The rule that carries an accepted update or delete through HAPI's per-entry checks: an Observation, nothing else. */
class ChangeRuleTest {

	private final ChangeRule rule = new ChangeRule();

	private PolicyEnum verdict(RestOperationTypeEnum op, String id) {
		var v = rule.applyRule(op, null, null, id == null ? null : new IdType(id), null, null, null, null);
		return v == null ? null : v.getDecision();
	}

	@Test
	void allowsAnObservationUpdateAndDelete_theControl() {
		assertEquals(PolicyEnum.ALLOW, verdict(RestOperationTypeEnum.UPDATE, "Observation/abc"));
		assertEquals(PolicyEnum.ALLOW, verdict(RestOperationTypeEnum.DELETE, "Observation/abc"));
	}

	@Test
	void allowsTheUpdateAndDeleteOfAnExistingObservationHapiPassesAsOutput() {
		for (var op : List.of(RestOperationTypeEnum.UPDATE, RestOperationTypeEnum.DELETE)) {
			var v = rule.applyRule(op, null, null, new IdType("Observation/abc"), new org.hl7.fhir.r4.model.Observation(), null, null, null);
			assertEquals(PolicyEnum.ALLOW, v.getDecision(), op.name());
		}
		assertNull(rule.applyRule(RestOperationTypeEnum.READ, null, null, new IdType("Observation/abc"), new org.hl7.fhir.r4.model.Observation(), null, null, null));
	}

	@Test
	void givesNoVerdictForAnythingElse() {
		assertNull(verdict(RestOperationTypeEnum.UPDATE, "Patient/abc"));
		assertNull(verdict(RestOperationTypeEnum.DELETE, "Device/abc"));
		assertNull(verdict(RestOperationTypeEnum.DELETE, null));
		for (var other : List.of(RestOperationTypeEnum.PATCH, RestOperationTypeEnum.CREATE, RestOperationTypeEnum.READ,
				RestOperationTypeEnum.SEARCH_TYPE, RestOperationTypeEnum.TRANSACTION)) {
			assertNull(verdict(other, "Observation/abc"), other.name());
		}
	}

	@Test
	void isInTheRulesOnlyForTheCaptureRoleAndOnlyWhenAChangeWasAccepted() {
		var roles = List.of("capture-writer");
		var without = PocAuthorizationInterceptor.rulesFor(roles);
		var with = PocAuthorizationInterceptor.rulesFor(roles, false, true);
		assertEquals(without.size() + 1, with.size());
		assertEquals(false, without.stream().anyMatch(r -> r instanceof ChangeRule));
		assertEquals(true, with.stream().anyMatch(r -> r instanceof ChangeRule));
		assertEquals(false, with.get(with.size() - 1) instanceof ChangeRule); // the final deny stays last
		for (var role : List.of("clinician-reader", "worker-reader", "other")) {
			assertEquals(false, PocAuthorizationInterceptor.rulesFor(List.of(role), false, true).stream().anyMatch(r -> r instanceof ChangeRule), role);
		}
	}
}
