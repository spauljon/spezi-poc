package com.aboutobjects.poc.hapi;

import ca.uhn.fhir.rest.api.RequestTypeEnum;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Collection;
import java.util.Iterator;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The ONE write the capture role may make besides creating: <b>retract its own Observation</b> (M21, decision D2).
 *
 * <p>HealthKit reports a sample deleted (and MyFitnessPal edits an entry by deleting its samples and writing new ones).
 * The capture role may not update or delete, so a deleted sample would stay {@code final} on the server and be counted
 * twice. This policy lets it say "this Observation was entered in error" and nothing else:
 *
 * <pre>PATCH [base]/Observation?identifier=&lt;an app sample-identifier system&gt;|&lt;value&gt;
 * Content-Type: application/json-patch+json
 * [{"op": "replace", "path": "/status", "value": "entered-in-error"}]</pre>
 *
 * <p>HAPI's rule builder can allow or deny PATCH as a whole but cannot look inside it, so the rule list allows PATCH
 * for the capture role and this policy is the guard in front of it: every shape not listed above is refused. In
 * particular: no PATCH by id, no other resource type, no search parameter but one {@code identifier} naming one
 * value in one of the app's own identifier systems (so a retraction can match at most the Observation the app wrote
 * for that sample), exactly one operation, and that operation replaces {@code /status} with
 * {@code entered-in-error}. Fails closed: with no configured system nothing is allowed.
 */
final class RetractionPolicy {

	static final String PATCH_MEDIA_TYPE = "application/json-patch+json";
	static final String RETRACTED = "entered-in-error";
	private static final int MAX_BODY_BYTES = 1024;
	private static final ObjectMapper ourMapper = new ObjectMapper();

	private final Set<String> mySystems;

	RetractionPolicy(Collection<String> theIdentifierSystems) {
		mySystems = Set.copyOf(theIdentifierSystems);
	}

	/**
	 * @param theParameters the request's search parameters (name to values)
	 * @return {@code null} when the request is the permitted retraction, otherwise a short reason for the log
	 */
	String refusal(
			RequestTypeEnum theType,
			String theResourceType,
			String theResourceId,
			Map<String, String[]> theParameters,
			String theContentType,
			byte[] theBody) {
		if (theType != RequestTypeEnum.PATCH) {
			return "not a PATCH";
		}
		if (!"Observation".equals(theResourceType)) {
			return "not an Observation";
		}
		if (theResourceId != null && !theResourceId.isEmpty()) {
			return "a PATCH by id (only a conditional PATCH by sample identifier is allowed)";
		}
		String identifier = singleIdentifier(theParameters);
		if (identifier == null) {
			return "the search must be exactly one identifier parameter";
		}
		int bar = identifier.indexOf('|');
		String system = bar < 0 ? "" : identifier.substring(0, bar);
		String value = bar < 0 ? "" : identifier.substring(bar + 1);
		if (!mySystems.contains(system)) {
			return "the identifier system is not one of the app's own";
		}
		if (value.isEmpty() || value.contains("|") || value.contains(",") || value.contains("$")) {
			return "the identifier value must be one plain value";
		}
		if (!isPatchMediaType(theContentType)) {
			return "the body is not application/json-patch+json";
		}
		return bodyRefusal(theBody);
	}

	/** Exactly one parameter, named exactly {@code identifier} (no modifier), with exactly one value. */
	private static String singleIdentifier(Map<String, String[]> theParameters) {
		if (theParameters == null || theParameters.size() != 1) {
			return null;
		}
		String[] values = theParameters.get("identifier");
		return values != null && values.length == 1 ? values[0] : null;
	}

	private static boolean isPatchMediaType(String theContentType) {
		if (theContentType == null) {
			return false;
		}
		String type = theContentType.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
		return PATCH_MEDIA_TYPE.equals(type);
	}

	/** One operation, replace, /status, "entered-in-error": nothing else, no extra member. */
	private static String bodyRefusal(byte[] theBody) {
		if (theBody == null || theBody.length == 0 || theBody.length > MAX_BODY_BYTES) {
			return "the body is empty or larger than expected";
		}
		JsonNode root;
		try {
			root = ourMapper.readTree(theBody);
		} catch (Exception e) {
			return "the body is not JSON";
		}
		if (root == null || !root.isArray() || root.size() != 1) {
			return "the body must be an array of exactly one operation";
		}
		JsonNode operation = root.get(0);
		if (!operation.isObject() || operation.size() != 3) {
			return "the operation must have exactly op, path and value";
		}
		for (Iterator<String> names = operation.fieldNames(); names.hasNext(); ) {
			String name = names.next();
			if (!name.equals("op") && !name.equals("path") && !name.equals("value")) {
				return "the operation has a member other than op, path and value";
			}
		}
		if (!"replace".equals(text(operation, "op"))) {
			return "the operation is not a replace";
		}
		if (!"/status".equals(text(operation, "path"))) {
			return "the operation does not target /status";
		}
		if (!RETRACTED.equals(text(operation, "value"))) {
			return "the new status is not entered-in-error";
		}
		return null;
	}

	/** The string value of a member, or {@code null} when it is absent or not a JSON string. */
	private static String text(JsonNode theObject, String theName) {
		JsonNode node = theObject.get(theName);
		return node != null && node.isTextual() ? node.asText() : null;
	}
}
