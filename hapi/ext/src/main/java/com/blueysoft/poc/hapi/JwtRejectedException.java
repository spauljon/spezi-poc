package com.blueysoft.poc.hapi;

/** The presented token is not acceptable. The message is for the server log only, never sent to the client. */
public class JwtRejectedException extends Exception {
	public JwtRejectedException(String theReason) {
		super(theReason);
	}

	public JwtRejectedException(String theReason, Throwable theCause) {
		super(theReason, theCause);
	}
}
