package com.blueysoft.poc.hapi;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import ca.uhn.fhir.rest.api.RequestTypeEnum;
import ca.uhn.fhir.rest.api.RestOperationTypeEnum;
import org.junit.jupiter.api.Test;

class PocAuthorizationInterceptorTest {

	@Test
	void bearerParsing() {
		assertEquals("abc", PocAuthorizationInterceptor.bearerToken("Bearer abc"));
		assertEquals("abc", PocAuthorizationInterceptor.bearerToken("bearer   abc "));
		assertNull(PocAuthorizationInterceptor.bearerToken("Basic abc"));
		assertNull(PocAuthorizationInterceptor.bearerToken("Bearer"));
		assertNull(PocAuthorizationInterceptor.bearerToken("Bearer a b"));
		assertNull(PocAuthorizationInterceptor.bearerToken(""));
		assertNull(PocAuthorizationInterceptor.bearerToken(null));
	}

	@Test
	void onlyAGetOfMetadataIsTheCapabilityStatement() {
		assertTrue(PocAuthorizationInterceptor.isCapabilityStatement(RequestTypeEnum.GET, "metadata", null)); // positive controls
		assertTrue(PocAuthorizationInterceptor.isCapabilityStatement(RequestTypeEnum.GET, null, RestOperationTypeEnum.METADATA));
		assertFalse(PocAuthorizationInterceptor.isCapabilityStatement(RequestTypeEnum.POST, "metadata", null));
		assertFalse(PocAuthorizationInterceptor.isCapabilityStatement(RequestTypeEnum.DELETE, "metadata", RestOperationTypeEnum.METADATA));
		assertFalse(PocAuthorizationInterceptor.isCapabilityStatement(RequestTypeEnum.GET, "Patient", RestOperationTypeEnum.SEARCH_TYPE));
		assertFalse(PocAuthorizationInterceptor.isCapabilityStatement(RequestTypeEnum.GET, "Metadata", null));
		assertFalse(PocAuthorizationInterceptor.isCapabilityStatement(RequestTypeEnum.GET, null, null));
	}

	@Test
	void unknownRolesGetOnlyTheFinalDeny() {
		assertEquals(1, PocAuthorizationInterceptor.rulesFor(java.util.List.of()).size());
		assertEquals(1, PocAuthorizationInterceptor.rulesFor(java.util.List.of("some-other-role")).size());
		assertTrue(PocAuthorizationInterceptor.rulesFor(java.util.List.of("capture-writer")).size() > 1); // control
	}
}
