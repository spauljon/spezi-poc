package com.aboutobjects.poc.hapi;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;

import ca.uhn.fhir.rest.api.RequestTypeEnum;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The retraction guard: one permitted request, and a refusal for each way it could differ. Every refusal is proved by
 * changing exactly ONE thing from the permitted request (which is accepted first, as the control), so a refusal cannot
 * pass because the policy refuses everything.
 */
class RetractionPolicyTest {

	private static final String HEALTHKIT = "http://aboutobjects.com/fhir/identifier/healthkit-sample";
	private static final String SYNTHETIC = "http://aboutobjects.com/fhir/identifier/synthetic-sample";
	private static final String PATCH = "[{\"op\":\"replace\",\"path\":\"/status\",\"value\":\"entered-in-error\"}]";

	private final RetractionPolicy policy = new RetractionPolicy(List.of(HEALTHKIT, SYNTHETIC));

	private String check(RequestTypeEnum type, String resource, String id, Map<String, String[]> params, String contentType, String body) {
		return policy.refusal(type, resource, id, params, contentType, body == null ? null : body.getBytes(StandardCharsets.UTF_8));
	}

	private static Map<String, String[]> identifier(String value) {
		return Map.of("identifier", new String[] {value});
	}

	/** The permitted request with one part replaced. */
	private String permittedExcept(RequestTypeEnum type, String resource, String id, Map<String, String[]> params, String contentType, String body) {
		return check(type, resource, id, params, contentType, body);
	}

	private String permitted() {
		return check(RequestTypeEnum.PATCH, "Observation", null, identifier(HEALTHKIT + "|3f2504e0-4f89-11d3-9a0c-0305e82c3301"),
				"application/json-patch+json", PATCH);
	}

	@Test
	void theExactRetractionIsPermitted_theControl() {
		assertNull(permitted());
		// the synthetic identifier system is also the app's own, and the charset parameter is not a different media type
		assertNull(check(RequestTypeEnum.PATCH, "Observation", null, identifier(SYNTHETIC + "|syn-1-hr-5"),
				"Application/JSON-Patch+JSON; charset=utf-8", PATCH));
		// white space inside the JSON is not a different operation
		assertNull(check(RequestTypeEnum.PATCH, "Observation", null, identifier(HEALTHKIT + "|x"), "application/json-patch+json",
				"[ { \"path\" : \"/status\", \"value\" : \"entered-in-error\", \"op\" : \"replace\" } ]"));
	}

	@Test
	void onlyAPatchIsConsidered() {
		for (RequestTypeEnum other : List.of(RequestTypeEnum.PUT, RequestTypeEnum.DELETE, RequestTypeEnum.POST, RequestTypeEnum.GET)) {
			assertNotNull(permittedExcept(other, "Observation", null, identifier(HEALTHKIT + "|x"), "application/json-patch+json", PATCH), other.name());
		}
	}

	@Test
	void onlyAnObservationByIdentifierNotById() {
		for (String type : List.of("Patient", "Device", "Condition", "observation", "")) {
			assertNotNull(permittedExcept(RequestTypeEnum.PATCH, type, null, identifier(HEALTHKIT + "|x"), "application/json-patch+json", PATCH), type);
		}
		assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", "123", identifier(HEALTHKIT + "|x"), "application/json-patch+json", PATCH));
		assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", null, null, "application/json-patch+json", PATCH));
		assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", null, Map.of(), "application/json-patch+json", PATCH));
	}

	@Test
	void theSearchIsExactlyOneIdentifierOfTheAppsOwn() {
		String ct = "application/json-patch+json";
		// a second parameter would widen what could match
		assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", null,
				Map.of("identifier", new String[] {HEALTHKIT + "|x"}, "subject", new String[] {"Patient/1"}), ct, PATCH));
		assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", null, Map.of("subject", new String[] {"Patient/1"}), ct, PATCH));
		assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", null, Map.of("_id", new String[] {"1"}), ct, PATCH));
		assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", null, Map.of("identifier:not", new String[] {HEALTHKIT + "|x"}), ct, PATCH));
		assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", null, Map.of("identifier", new String[] {HEALTHKIT + "|x", HEALTHKIT + "|y"}), ct, PATCH));
		// another system, no system, an empty value, and anything that means "or" or "several"
		for (String value : List.of(
				"http://example.org/other|x", "x", "|x", HEALTHKIT + "|", HEALTHKIT,
				HEALTHKIT + "|a,b", HEALTHKIT + "|a|b", HEALTHKIT + "|a$b", SYNTHETIC + "," + HEALTHKIT + "|a")) {
			assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", null, identifier(value), ct, PATCH), value);
		}
	}

	@Test
	void theMediaTypeMustBeJsonPatch() {
		for (String contentType : List.of("application/fhir+json", "application/json", "application/xml-patch+xml", "text/plain", "", "application/json-patch+json2")) {
			assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", null, identifier(HEALTHKIT + "|x"), contentType, PATCH), contentType);
		}
		assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", null, identifier(HEALTHKIT + "|x"), null, PATCH));
	}

	@Test
	void theBodyIsExactlyOneStatusRetraction() {
		String ct = "application/json-patch+json";
		Map<String, String[]> id = identifier(HEALTHKIT + "|x");
		for (String body : List.of(
				"",
				"not json",
				"{}",
				"{\"op\":\"replace\",\"path\":\"/status\",\"value\":\"entered-in-error\"}", // an object, not an array
				"[]",
				PATCH.replace("]", ",") + "{\"op\":\"replace\",\"path\":\"/status\",\"value\":\"entered-in-error\"}]", // two operations
				"[{\"op\":\"add\",\"path\":\"/status\",\"value\":\"entered-in-error\"}]",
				"[{\"op\":\"remove\",\"path\":\"/status\"}]",
				"[{\"op\":\"test\",\"path\":\"/status\",\"value\":\"entered-in-error\"}]",
				"[{\"op\":\"copy\",\"from\":\"/code\",\"path\":\"/status\"}]",
				"[{\"op\":\"replace\",\"path\":\"/valueQuantity/value\",\"value\":\"entered-in-error\"}]",
				"[{\"op\":\"replace\",\"path\":\"/status/extra\",\"value\":\"entered-in-error\"}]",
				"[{\"op\":\"replace\",\"path\":\"/code\",\"value\":\"entered-in-error\"}]",
				"[{\"op\":\"replace\",\"path\":\"/status\",\"value\":\"final\"}]",
				"[{\"op\":\"replace\",\"path\":\"/status\",\"value\":\"Entered-In-Error\"}]",
				"[{\"op\":\"replace\",\"path\":\"/status\",\"value\":null}]",
				"[{\"op\":\"replace\",\"path\":\"/status\",\"value\":[\"entered-in-error\"]}]",
				"[{\"op\":\"replace\",\"path\":\"/status\",\"value\":\"entered-in-error\",\"from\":\"/code\"}]", // an extra member
				"[{\"op\":\"replace\",\"path\":\"/status\"}]", // value missing
				"[\"replace\"]",
				"[null]")) {
			assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", null, id, ct, body), body);
		}
		assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", null, id, ct, null));
		assertNotNull(permittedExcept(RequestTypeEnum.PATCH, "Observation", null, id, ct, " ".repeat(2000) + PATCH), "a body larger than expected");
	}

	@Test
	void withNothingConfiguredNothingIsAllowed() {
		RetractionPolicy none = new RetractionPolicy(List.of());
		assertNotNull(none.refusal(RequestTypeEnum.PATCH, "Observation", null, identifier(HEALTHKIT + "|x"), "application/json-patch+json",
				PATCH.getBytes(StandardCharsets.UTF_8)));
		assertNull(permitted(), "and the same request is allowed by a configured policy (the control)");
		assertEquals("not a PATCH", check(RequestTypeEnum.DELETE, "Observation", null, identifier(HEALTHKIT + "|x"), "application/json-patch+json", PATCH));
	}
}
