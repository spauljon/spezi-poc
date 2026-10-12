import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppUser, AuthClient } from "./client.ts";

export type AuthState =
  | { readonly status: "loading" }
  | { readonly status: "signedOut" }
  | { readonly status: "signedIn"; readonly user: AppUser }
  | { readonly status: "error"; readonly message: string };

export interface AuthContextValue {
  readonly state: AuthState;
  signIn(): void;
  signOut(): void;
  accessToken(): Promise<string>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error("useAuth must be used inside an AuthProvider");
  }
  return value;
}

const CALLBACK_PATH = "/callback";

/**
 * Holds the sign-in state. On the redirect URI it completes the code exchange and removes the code and state from the
 * address bar; elsewhere it shows "signed out" with a button (no automatic redirect, so an error cannot loop).
 */
export function AuthProvider({ client, children, location = window.location, history = window.history }: {
  client: AuthClient;
  children: ReactNode;
  location?: Pick<Location, "pathname" | "href" | "origin">;
  history?: Pick<History, "replaceState">;
}) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return; // React strict mode runs effects twice; an authorization code can be redeemed once
    }
    started.current = true;
    const run = async () => {
      try {
        if (location.pathname === CALLBACK_PATH) {
          const user = await client.completeSignIn(location.href);
          history.replaceState(null, "", "/");
          setState({ status: "signedIn", user });
          return;
        }
        const user = await client.getUser();
        setState(user ? { status: "signedIn", user } : { status: "signedOut" });
      } catch {
        history.replaceState(null, "", "/");
        setState({ status: "error", message: "Sign-in could not be completed. Please try again." });
      }
    };
    void run();
  }, [client, location, history]);

  useEffect(() => client.onSignedOut(() => setState({ status: "signedOut" })), [client]);

  const signIn = useCallback(() => {
    void client.signIn().catch(() =>
      setState({ status: "error", message: "The sign-in service could not be reached." }));
  }, [client]);
  const signOut = useCallback(() => {
    void client.signOut().then(() => setState({ status: "signedOut" }));
  }, [client]);
  const accessToken = useCallback(() => client.accessToken(), [client]);

  const value = useMemo(() => ({ state, signIn, signOut, accessToken }), [state, signIn, signOut, accessToken]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
