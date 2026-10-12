import { InMemoryWebStorage, UserManager, WebStorageStateStore, type UserManagerSettings } from "oidc-client-ts";
import type { WebConfig } from "../config.ts";

export interface AppUser {
  readonly username: string | null;
  readonly roles: readonly string[];
  /** Epoch ms. */
  readonly expiresAt: number;
}

/** What the app needs from an OIDC client: small, so tests use a fake and never a browser redirect. */
export interface AuthClient {
  /** The signed-in user, if this page already holds a session. */
  getUser(): Promise<AppUser | null>;
  /** Starts the authorization code + PKCE flow (navigates away). */
  signIn(): Promise<void>;
  /** Completes the flow on the redirect URI; resolves the user. */
  completeSignIn(url: string): Promise<AppUser>;
  /** An access token that is valid now (renewed ahead of expiry by the library). */
  accessToken(): Promise<string>;
  /** Forgets the session in this page. */
  signOut(): Promise<void>;
  onSignedOut(callback: () => void): () => void;
}

/** Reads display claims from an access token. Display only: the servers verify the token, this never decides access. */
export function claimsOf(token: string): { username: string | null; roles: string[] } {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as {
      preferred_username?: unknown;
      roles?: unknown;
    };
    return {
      username: typeof json.preferred_username === "string" ? json.preferred_username : null,
      roles: Array.isArray(json.roles) ? json.roles.filter((r): r is string => typeof r === "string") : [],
    };
  } catch {
    return { username: null, roles: [] };
  }
}

/** The library settings, a pure function so tests can read exactly what the app asks of the library. */
export function oidcSettings(config: WebConfig): UserManagerSettings {
  return {
    authority: config.issuer,
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid profile",
    userStore: new WebStorageStateStore({ store: new InMemoryWebStorage() }),
    automaticSilentRenew: true,
    loadUserInfo: false,
    monitorSession: false,
  };
}

/**
 * Authorization code with PKCE (S256, the library's default) against Keycloak. Deliberate choices:
 *  - The user (and so the tokens) live in memory only: nothing is written to localStorage or sessionStorage, so a
 *    script that reads storage finds no token. A page reload asks the clinician to sign in again (Keycloak's own
 *    session makes that one click).
 *  - Refresh uses the refresh token while the page is open (`automaticSilentRenew`).
 *  - Sign-out forgets the session in this page only; ending the Keycloak session needs a registered post-logout
 *    URI, which the realm does not have yet.
 */
export class OidcAuthClient implements AuthClient {
  private readonly manager: UserManager;

  constructor(config: WebConfig) {
    this.manager = new UserManager(oidcSettings(config));
  }

  async getUser(): Promise<AppUser | null> {
    return toUser(await this.manager.getUser());
  }

  async signIn(): Promise<void> {
    await this.manager.signinRedirect();
  }

  async completeSignIn(url: string): Promise<AppUser> {
    const user = toUser(await this.manager.signinRedirectCallback(url));
    if (!user) {
      throw new Error("The sign-in did not produce a session.");
    }
    return user;
  }

  async accessToken(): Promise<string> {
    const user = await this.manager.getUser();
    if (!user || user.expired) {
      throw new Error("Not signed in.");
    }
    return user.access_token;
  }

  async signOut(): Promise<void> {
    await this.manager.removeUser();
  }

  onSignedOut(callback: () => void): () => void {
    this.manager.events.addAccessTokenExpired(callback);
    this.manager.events.addUserSignedOut(callback);
    return () => {
      this.manager.events.removeAccessTokenExpired(callback);
      this.manager.events.removeUserSignedOut(callback);
    };
  }
}

function toUser(user: { access_token: string; expires_at?: number | undefined } | null): AppUser | null {
  if (!user) {
    return null;
  }
  const claims = claimsOf(user.access_token);
  return { username: claims.username, roles: claims.roles, expiresAt: (user.expires_at ?? 0) * 1000 };
}
