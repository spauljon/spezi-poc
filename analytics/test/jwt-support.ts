import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { JwtVerifier, type VerifierOptions } from "../src/jwt.ts";

export const ISSUER = "https://idp.test/realms/poc";
export const AUDIENCE = "poc-analytics";
export const NOW = Date.parse("2026-10-12T12:00:00Z");

export interface TestKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

export function newKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" } };
}

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");

export interface Mint {
  key: TestKey;
  header?: Record<string, unknown>;
  claims?: Record<string, unknown>;
}

/** A signed token with sensible defaults (valid for the poc-analytics audience and the clinician-reader role). */
export function mint({ key, header = {}, claims = {} }: Mint): string {
  const h = b64({ alg: "RS256", typ: "JWT", kid: key.kid, ...header });
  const p = b64({
    iss: ISSUER, aud: [AUDIENCE], sub: "synthetic-subject", roles: ["clinician-reader"],
    iat: NOW / 1000, exp: NOW / 1000 + 600, ...claims,
  });
  const signature = createSign("RSA-SHA256").update(`${h}.${p}`).sign(key.privateKey).toString("base64url");
  return `${h}.${p}.${signature}`;
}

export interface JwksServer {
  fetchImpl: typeof fetch;
  calls: number;
  set(keys: TestKey[]): void;
  fail(down: boolean): void;
}

export function jwksServer(initial: TestKey[]): JwksServer {
  let keys = initial;
  let down = false;
  const server: JwksServer = {
    calls: 0,
    set: (k) => { keys = k; },
    fail: (d) => { down = d; },
    fetchImpl: (async () => {
      server.calls++;
      if (down) {
        return new Response("unavailable", { status: 503 });
      }
      return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }), { status: 200 });
    }) as typeof fetch,
  };
  return server;
}

export function verifierFor(jwks: JwksServer, extra: Partial<VerifierOptions> = {}, now: () => number = () => NOW): JwtVerifier {
  return new JwtVerifier({
    issuer: ISSUER, audience: AUDIENCE, role: "clinician-reader", fetchImpl: jwks.fetchImpl, now,
    minRefreshMs: 30_000, ...extra,
  });
}
