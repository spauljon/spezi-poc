package com.aboutobjects.poc.hapi;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Observation;
import org.hl7.fhir.r4.model.Patient;
import org.junit.jupiter.api.Test;

/** The guard for a capture-role update or delete inside a transaction. Every refusal has the accepted request beside it. */
class ChangePolicyTest {

	private static final String SAMPLE = "http://aboutobjects.com/fhir/identifier/healthconnect-sample";
	private static final String GROUP = "http://aboutobjects.com/fhir/identifier/healthconnect-group";
	private static final String HEALTHKIT = "http://aboutobjects.com/fhir/identifier/healthkit-sample";
	private static final String URL = "Observation?identifier=http%3A%2F%2Faboutobjects.com%2Ffhir%2Fidentifier%2Fhealthconnect-sample%7Cabc123";

	private final ChangePolicy policy = new ChangePolicy(List.of(SAMPLE));

	private static Observation observation(String system, String value) {
		var o = new Observation();
		o.addIdentifier().setSystem(system).setValue(value);
		o.setStatus(Observation.ObservationStatus.FINAL);
		return o;
	}

	private String put(String url, org.hl7.fhir.r4.model.Resource body) {
		return policy.entryRefusal(Bundle.HTTPVerb.PUT, url, body);
	}

	private String delete(String url) {
		return policy.entryRefusal(Bundle.HTTPVerb.DELETE, url, null);
	}

	@Test
	void acceptsTheExactUpdateAndTheExactDelete_theControls() {
		assertNull(put(URL, observation(SAMPLE, "abc123")));
		assertNull(delete(URL));
		assertNull(put(URL.replace("%7C", "|").replace("%3A", ":").replace("%2F", "/"), observation(SAMPLE, "abc123"))); // an unencoded URL reads the same
	}

	@Test
	void refusesAnUpdateOrDeleteByIdOrOfAnotherType() {
		assertNotNull(put("Observation/123", observation(SAMPLE, "abc123")));
		assertNotNull(delete("Observation/123"));
		assertNotNull(delete("Patient?identifier=" + SAMPLE + "|abc123"));
		assertNotNull(put("Patient?identifier=" + SAMPLE + "|abc123", new Patient()));
		assertNotNull(delete("Observation"));
		assertNotNull(delete(null));
	}

	@Test
	void refusesAnythingButOneIdentifierInAChangeSystem() {
		assertNotNull(delete("Observation?identifier=" + HEALTHKIT + "|abc123")); // another system: iOS retracts, it never deletes
		assertNotNull(delete("Observation?identifier=" + GROUP + "|abc123")); // the group names a whole record
		assertNotNull(delete("Observation?identifier=abc123")); // no system
		assertNotNull(delete("Observation?identifier=" + SAMPLE + "|"));
		assertNotNull(delete("Observation?identifier=" + SAMPLE + "|a,b"));
		assertNotNull(delete("Observation?identifier=" + SAMPLE + "|a|b"));
		assertNotNull(delete("Observation?identifier=" + SAMPLE + "|abc123&patient=Patient/1"));
		assertNotNull(delete("Observation?status=final"));
		assertNotNull(delete("Observation?_id=1&identifier=" + SAMPLE + "|abc123"));
		assertNotNull(delete("Observation?identifier:not=" + SAMPLE + "|abc123"));
		assertNotNull(delete("Observation?identifier=%ZZ"));
	}

	@Test
	void refusesAnUpdateThatChangesOrDropsTheIdentifierOrNamesAnId() {
		assertNotNull(put(URL, observation(SAMPLE, "other")));
		assertNotNull(put(URL, observation(GROUP, "abc123")));
		assertNotNull(put(URL, new Observation())); // no identifier
		var withId = observation(SAMPLE, "abc123");
		withId.setId("999");
		assertNotNull(put(URL, withId));
		var fromFullUrl = observation(SAMPLE, "abc123");
		fromFullUrl.setId("urn:uuid:11111111-2222-4333-8444-555555555555"); // what HAPI sets from the entry's fullUrl
		assertNull(put(URL, fromFullUrl)); // control: that is not a client-chosen id
		assertNotNull(put(URL, null));
		assertNotNull(policy.entryRefusal(Bundle.HTTPVerb.DELETE, URL, observation(SAMPLE, "abc123"))); // a delete carries no body
	}

	@Test
	void refusesPostPatchAndGetHere() {
		for (var verb : List.of(Bundle.HTTPVerb.POST, Bundle.HTTPVerb.PATCH, Bundle.HTTPVerb.GET)) {
			assertNotNull(policy.entryRefusal(verb, URL, observation(SAMPLE, "abc123")), verb.name());
		}
	}

	@Test
	void failsClosedWithNoConfiguredSystem() {
		assertNotNull(new ChangePolicy(List.of()).entryRefusal(Bundle.HTTPVerb.DELETE, URL, null));
		assertNull(policy.entryRefusal(Bundle.HTTPVerb.DELETE, URL, null)); // control
	}

	@Test
	void aBundleIsRefusedForOneBadEntryAndAcceptedWhenAllAreGood() {
		var good = new Bundle();
		good.addEntry().getRequest().setMethod(Bundle.HTTPVerb.POST).setUrl("Observation");
		good.addEntry().setResource(observation(SAMPLE, "abc123")).getRequest().setMethod(Bundle.HTTPVerb.PUT).setUrl(URL);
		good.addEntry().getRequest().setMethod(Bundle.HTTPVerb.DELETE).setUrl(URL);
		assertEquals(true, ChangePolicy.hasChange(good));
		assertNull(policy.bundleRefusal(good));

		var bad = good.copy();
		bad.addEntry().getRequest().setMethod(Bundle.HTTPVerb.DELETE).setUrl("Observation/1");
		assertNotNull(policy.bundleRefusal(bad));

		var onlyCreates = new Bundle();
		onlyCreates.addEntry().getRequest().setMethod(Bundle.HTTPVerb.POST).setUrl("Observation");
		assertEquals(false, ChangePolicy.hasChange(onlyCreates));
		assertNull(policy.bundleRefusal(onlyCreates));
	}
}
