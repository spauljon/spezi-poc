package com.aboutobjects.poc.hapi;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.Collection;
import java.util.Set;
import org.hl7.fhir.r4.model.Bundle;
import org.hl7.fhir.r4.model.Identifier;
import org.hl7.fhir.r4.model.Observation;
import org.hl7.fhir.r4.model.Resource;

/**
 * The second write the capture role may make besides creating (M27, decision A11): <b>update or delete its own
 * Health Connect Observation</b>, found by sample identity, inside a transaction Bundle.
 *
 * <p>A Health Connect record can grow or be edited (an update of the same Observation) and can be deleted (a delete),
 * so a retraction by status is not enough. The permitted entries are exactly:
 *
 * <pre>PUT    Observation?identifier=&lt;change system&gt;|&lt;value&gt;   body: an Observation carrying that identifier, no id of its own
 * DELETE Observation?identifier=&lt;change system&gt;|&lt;value&gt;   no body</pre>
 *
 * <p>Nothing else: no id in the URL, no other resource type, no other or second search parameter, one plain
 * identifier value in one of the configured systems (so an entry matches at most the Observation the app wrote for
 * that sample), and an update may not change or drop that identifier. Direct (non-transaction) PUT and DELETE stay
 * refused by the role's rules. HAPI deletes softly (a new version marked deleted); a conditional PUT that matches
 * nothing creates. Fails closed: with no configured system nothing is allowed.
 */
final class ChangePolicy {

	private final Set<String> mySystems;

	ChangePolicy(Collection<String> theIdentifierSystems) {
		mySystems = Set.copyOf(theIdentifierSystems);
	}

	static boolean isChange(Bundle.BundleEntryComponent theEntry) {
		if (!theEntry.hasRequest() || !theEntry.getRequest().hasMethod()) {
			return false;
		}
		var method = theEntry.getRequest().getMethod();
		return method == Bundle.HTTPVerb.PUT || method == Bundle.HTTPVerb.DELETE;
	}

	/** @return {@code null} when every PUT and DELETE entry is permitted (a Bundle with none is fine), otherwise a reason for the log */
	String bundleRefusal(Bundle theBundle) {
		for (var entry : theBundle.getEntry()) {
			if (isChange(entry)) {
				String refusal = entryRefusal(entry.getRequest().getMethod(), entry.getRequest().getUrl(), entry.getResource());
				if (refusal != null) {
					return refusal;
				}
			}
		}
		return null;
	}

	static boolean hasChange(Bundle theBundle) {
		return theBundle.getEntry().stream().anyMatch(ChangePolicy::isChange);
	}

	String entryRefusal(Bundle.HTTPVerb theMethod, String theUrl, Resource theResource) {
		if (theMethod != Bundle.HTTPVerb.PUT && theMethod != Bundle.HTTPVerb.DELETE) {
			return "not a PUT or DELETE";
		}
		String identifier = singleIdentifier(theUrl);
		if (identifier == null) {
			return "the URL must be Observation?identifier=<system>|<value> and nothing else";
		}
		int bar = identifier.indexOf('|');
		String system = bar < 0 ? "" : identifier.substring(0, bar);
		String value = bar < 0 ? "" : identifier.substring(bar + 1);
		if (!mySystems.contains(system)) {
			return "the identifier system is not one that may be changed";
		}
		if (value.isEmpty() || value.contains("|") || value.contains(",") || value.contains("$")) {
			return "the identifier value must be one plain value";
		}
		if (theMethod == Bundle.HTTPVerb.DELETE) {
			return theResource == null || theResource.isEmpty() ? null : "a DELETE carries no resource";
		}
		if (!(theResource instanceof Observation observation)) {
			return "an update must carry an Observation";
		}
		// a transaction entry's fullUrl (urn:uuid:...) becomes the parsed resource's id; any other id would name a stored resource
		if (observation.hasId() && !observation.getId().startsWith("urn:uuid:") || observation.hasMeta() && observation.getMeta().hasVersionId()) {
			return "an update must not name an id or a version";
		}
		for (Identifier id : observation.getIdentifier()) {
			if (system.equals(id.getSystem()) && value.equals(id.getValue())) {
				return null;
			}
		}
		return "the update's identifier is not the one in the URL";
	}

	/** The decoded identifier from exactly {@code Observation?identifier=<token>}, else {@code null}. */
	private static String singleIdentifier(String theUrl) {
		if (theUrl == null) {
			return null;
		}
		String prefix = "Observation?identifier=";
		if (!theUrl.startsWith(prefix)) {
			return null;
		}
		String raw = theUrl.substring(prefix.length());
		if (raw.isEmpty() || raw.contains("&") || raw.contains("?") || raw.contains("#")) {
			return null;
		}
		try {
			return URLDecoder.decode(raw, StandardCharsets.UTF_8);
		} catch (IllegalArgumentException e) {
			return null;
		}
	}
}
