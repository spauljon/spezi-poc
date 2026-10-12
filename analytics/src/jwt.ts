import { createPublicKey, verify, type KeyObject } from "node:crypto";

export interface VerifierOptions {
  readonly issuer: string;
  /** Must be in `aud`. A token minted for another resource server (HAPI) is refused. */
  readonly audience: string;
  /** Must be in the flat `roles` claim. */
  readonly role: string;
  readonly jwksUri?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly leewayMs?: number;
  /** Minimum time between key-set fetches triggered by unknown key ids (a forged `kid` must not become a flood). */
  readonly minRefreshMs?: number;
}

export type Verdict =
  | { readonly ok: true; readonly subject: string; readonly roles: readonly string[] }
  /** 401: not a valid token for this API. 403: a valid token without the role. 503: keys unavailable. */
  | { readonly ok: false; readonly status: 401 | 403 | 503; readonly reason: string };

const MAX_TOKEN_CHARS = 8192;

interface Jwk {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  [k: string]: unknown;
}

interface Claims {
  iss?: unknown;
  aud?: unknown;
  exp?: unknown;
  nbf?: unknown;
  sub?: unknown;
  roles?: unknown;
}

const refuse = (status: 401 | 403 | 503, reason: string): Verdict => ({ ok: false, status, reason });

/** `aud` may be absent, one string or an array. */
function audiences(aud: unknown): unknown[] {
  if (Array.isArray(aud)) {
    return aud;
  }
  return aud === undefined ? [] : [aud];
}

/** Splits and decodes a compact JWS without trusting anything in it yet. */
function parseCompact(token: string):
  | { signed: string; signature: Buffer; header: { alg?: unknown; kid?: unknown }; claims: Claims }
  | { reason: string } {
  if (token.length === 0 || token.length > MAX_TOKEN_CHARS) {
    return { reason: "token size" };
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) {
    return { reason: "not a compact JWS" };
  }
  const [h, p, sig] = parts as [string, string, string];
  try {
    return {
      signed: `${h}.${p}`,
      signature: Buffer.from(sig, "base64url"),
      header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as { alg?: unknown; kid?: unknown },
      claims: JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Claims,
    };
  } catch {
    return { reason: "malformed header or claims" };
  }
}

/**
 * Verifies a Keycloak access token the way HAPI does (M4): signature against the issuer's published keys, then
 * issuer, audience, expiry, then the role. Only RS256 is accepted; `none`, HMAC and anything else is refused before
 * any key is touched (no algorithm confusion). Reasons are for logs and never contain the token.
 */
export class JwtVerifier {
  private keys = new Map<string, KeyObject>();
  private lastFetch = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly jwksUri: string;
  private readonly leewayMs: number;
  private readonly minRefreshMs: number;

  constructor(private readonly o: VerifierOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
    this.jwksUri = o.jwksUri ?? `${o.issuer}/protocol/openid-connect/certs`;
    this.leewayMs = o.leewayMs ?? 30_000;
    this.minRefreshMs = o.minRefreshMs ?? 30_000;
  }

  async verify(token: string): Promise<Verdict> {
    const parsed = parseCompact(token);
    if ("reason" in parsed) {
      return refuse(401, parsed.reason);
    }
    const { signed, signature, header, claims } = parsed;
    if (header.alg !== "RS256") {
      return refuse(401, "unsupported algorithm");
    }
    if (typeof header.kid !== "string" || header.kid.length === 0) {
      return refuse(401, "no key id");
    }

    const key = await this.keyFor(header.kid);
    if (key === "unavailable") {
      return refuse(503, "signing keys unavailable");
    }
    if (!key) {
      return refuse(401, "unknown signing key");
    }
    if (!verify("RSA-SHA256", Buffer.from(signed), key, signature)) {
      return refuse(401, "bad signature");
    }
    // Claims are only trusted from here, after the signature.
    return this.checkClaims(claims);
  }

  private checkClaims(claims: Claims): Verdict {
    if (claims.iss !== this.o.issuer) {
      return refuse(401, "wrong issuer");
    }
    if (!audiences(claims.aud).includes(this.o.audience)) {
      return refuse(401, "wrong audience");
    }
    const now = this.now();
    if (typeof claims.exp !== "number" || claims.exp * 1000 + this.leewayMs < now) {
      return refuse(401, "expired");
    }
    if (typeof claims.nbf === "number" && claims.nbf * 1000 - this.leewayMs > now) {
      return refuse(401, "not yet valid");
    }
    const roles = Array.isArray(claims.roles) ? claims.roles.filter((r): r is string => typeof r === "string") : [];
    if (!roles.includes(this.o.role)) {
      return refuse(403, "missing role");
    }
    return { ok: true, subject: typeof claims.sub === "string" ? claims.sub : "", roles };
  }

  private async keyFor(kid: string): Promise<KeyObject | null | "unavailable"> {
    const cached = this.keys.get(kid);
    if (cached) {
      return cached;
    }
    // Unknown kid: refresh the key set, at most once per minRefreshMs (key rotation, or a forged kid).
    if (this.now() - this.lastFetch >= this.minRefreshMs) {
      this.lastFetch = this.now();
      this.inflight ??= this.refresh().finally(() => {
        this.inflight = null;
      });
      try {
        await this.inflight;
      } catch {
        return this.keys.size === 0 ? "unavailable" : null;
      }
    } else if (this.inflight !== null) {
      try {
        await this.inflight;
      } catch {
        /* handled below by what is cached */
      }
    }
    const refreshed = this.keys.get(kid);
    if (refreshed) {
      return refreshed;
    }
    return this.keys.size === 0 ? "unavailable" : null;
  }

  private async refresh(): Promise<void> {
    const response = await this.fetchImpl(this.jwksUri, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`JWKS returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { keys?: Jwk[] };
    const next = new Map<string, KeyObject>();
    for (const jwk of body.keys ?? []) {
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || (jwk.use !== undefined && jwk.use !== "sig")) {
        continue;
      }
      try {
        next.set(jwk.kid, createPublicKey({ key: jwk as never, format: "jwk" }));
      } catch {
        /* skip a key that cannot be imported */
      }
    }
    if (next.size > 0) {
      this.keys = next;
    }
  }
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer ([A-Za-z0-9._~+/=-]+)$/.exec(header ?? "");
  return match?.[1] ?? null;
}
