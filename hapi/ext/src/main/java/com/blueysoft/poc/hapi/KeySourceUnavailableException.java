package com.blueysoft.poc.hapi;

/**
 * The signing keys could not be obtained (identity provider unreachable). This is NOT the client's
 * fault, so it maps to 503 rather than 401, and nothing is ever accepted without a verified signature.
 */
public class KeySourceUnavailableException extends Exception {
	public KeySourceUnavailableException(String theReason, Throwable theCause) {
		super(theReason, theCause);
	}
}
