import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { bearerToken } from "../src/jwt.ts";
import { ISSUER, NOW, jwksServer, mint, newKey, verifierFor } from "./jwt-support.ts";

const key = newKey("k1");

test("a valid token for this API and role is accepted", async () => {
  const v = verifierFor(jwksServer([key]));
  const verdict = await v.verify(mint({ key }));
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.ok && verdict.roles, ["clinician-reader"]);
});

test("a token with a tampered payload is refused (bad signature), the untampered one is accepted (control)", async () => {
  const v = verifierFor(jwksServer([key]));
  const good = mint({ key });
  assert.equal((await v.verify(good)).ok, true);
  const [h, p, s] = good.split(".") as [string, string, string];
  const claims = JSON.parse(Buffer.from(p, "base64url").toString()) as Record<string, unknown>;
  claims["roles"] = ["clinician-reader", "capture-writer"];
  const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
  const verdict = await v.verify(forged);
  assert.deepEqual(verdict, { ok: false, status: 401, reason: "bad signature" });
});

test("a token signed by another key that claims the same kid is refused", async () => {
  const attacker = newKey("k1");
  const verdict = await verifierFor(jwksServer([key])).verify(mint({ key: attacker }));
  assert.deepEqual(verdict, { ok: false, status: 401, reason: "bad signature" });
});

test("algorithm confusion is refused: none, HS256 keyed with the public key, ES256", async () => {
  const v = verifierFor(jwksServer([key]));
  const base = mint({ key });
  const [, p] = base.split(".") as [string, string, string];
  const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: "k1" })).toString("base64url")}.${p}.`;
  assert.equal((await v.verify(none)).ok, false);
  const hsHeader = Buffer.from(JSON.stringify({ alg: "HS256", kid: "k1" })).toString("base64url");
  const mac = createHmac("sha256", JSON.stringify(key.jwk)).update(`${hsHeader}.${p}`).digest("base64url");
  const hs = await v.verify(`${hsHeader}.${p}.${mac}`);
  assert.deepEqual(hs, { ok: false, status: 401, reason: "unsupported algorithm" });
  assert.deepEqual(await v.verify(mint({ key, header: { alg: "ES256" } })), { ok: false, status: 401, reason: "unsupported algorithm" });
});

test("wrong audience (a token minted for HAPI), wrong issuer, expired and not-yet-valid are each refused for that reason", async () => {
  const v = verifierFor(jwksServer([key]));
  assert.deepEqual(await v.verify(mint({ key, claims: { aud: ["hapi-fhir"] } })), { ok: false, status: 401, reason: "wrong audience" });
  assert.deepEqual(await v.verify(mint({ key, claims: { aud: "poc-analytics-other" } })), { ok: false, status: 401, reason: "wrong audience" });
  assert.deepEqual(await v.verify(mint({ key, claims: { iss: "https://evil.test/realms/poc" } })), { ok: false, status: 401, reason: "wrong issuer" });
  assert.deepEqual(await v.verify(mint({ key, claims: { exp: NOW / 1000 - 120 } })), { ok: false, status: 401, reason: "expired" });
  assert.deepEqual(await v.verify(mint({ key, claims: { nbf: NOW / 1000 + 120 } })), { ok: false, status: 401, reason: "not yet valid" });
  // inside the 30 s leeway on both sides is accepted (control for the boundaries above)
  assert.equal((await v.verify(mint({ key, claims: { exp: NOW / 1000 - 10 } }))).ok, true);
  assert.equal((await v.verify(mint({ key, claims: { nbf: NOW / 1000 + 10 } }))).ok, true);
});

test("audience may be a single string as well as an array", async () => {
  const v = verifierFor(jwksServer([key]));
  assert.equal((await v.verify(mint({ key, claims: { aud: "poc-analytics" } }))).ok, true);
  assert.equal((await v.verify(mint({ key, claims: { aud: ["hapi-fhir", "poc-analytics"] } }))).ok, true);
});

test("a valid token without the clinician role is 403, not 401", async () => {
  const v = verifierFor(jwksServer([key]));
  for (const roles of [["capture-writer"], ["worker-reader"], []]) {
    assert.deepEqual(await v.verify(mint({ key, claims: { roles } })), { ok: false, status: 403, reason: "missing role" });
  }
  const noRoles = await v.verify(mint({ key, claims: { roles: undefined } }));
  assert.equal(noRoles.ok, false);
  assert.equal(!noRoles.ok && noRoles.status, 403);
});

test("a role is checked only after the signature (an unsigned token with the role is 401, never 403 or 200)", async () => {
  const v = verifierFor(jwksServer([key]));
  const attacker = newKey("k1");
  const verdict = await v.verify(mint({ key: attacker, claims: { roles: ["capture-writer"] } }));
  assert.equal(!verdict.ok && verdict.status, 401);
});

test("an unknown kid triggers one key refresh and succeeds after a key rotation", async () => {
  const jwks = jwksServer([key]);
  let now = NOW;
  const v = verifierFor(jwks, {}, () => now);
  assert.equal((await v.verify(mint({ key }))).ok, true);
  assert.equal(jwks.calls, 1);
  const rotated = newKey("k2");
  jwks.set([key, rotated]);
  now += 60_000; // past the refresh interval; the token is also still within its lifetime + leeway? use fresh claims
  const token = mint({ key: rotated, claims: { exp: (NOW + 120_000) / 1000 } });
  assert.equal((await v.verify(token)).ok, true);
  assert.equal(jwks.calls, 2);
});

test("a flood of forged key ids causes at most one key fetch per interval", async () => {
  const jwks = jwksServer([key]);
  const v = verifierFor(jwks);
  assert.equal((await v.verify(mint({ key }))).ok, true);
  const before = jwks.calls;
  for (let i = 0; i < 25; i++) {
    const verdict = await v.verify(mint({ key: newKey(`forged-${i}`) }));
    assert.deepEqual(verdict, { ok: false, status: 401, reason: "unknown signing key" });
  }
  assert.ok(jwks.calls - before <= 1, `expected at most one refresh, saw ${jwks.calls - before}`);
});

test("when the key set cannot be fetched and nothing is cached the answer is 503, not 401", async () => {
  const jwks = jwksServer([key]);
  jwks.fail(true);
  assert.deepEqual(await verifierFor(jwks).verify(mint({ key })), { ok: false, status: 503, reason: "signing keys unavailable" });
  jwks.fail(false); // positive control: with the keys back the same token is accepted
  assert.equal((await verifierFor(jwks).verify(mint({ key }))).ok, true);
});

test("cached keys keep working while the key endpoint is down", async () => {
  const jwks = jwksServer([key]);
  const v = verifierFor(jwks);
  assert.equal((await v.verify(mint({ key }))).ok, true);
  jwks.fail(true);
  assert.equal((await v.verify(mint({ key }))).ok, true);
});

test("malformed tokens are refused without throwing", async () => {
  const v = verifierFor(jwksServer([key]));
  for (const t of ["", "abc", "a.b", "a.b.c.d", "!!.!!.!!", `${"a".repeat(9000)}.b.c`, "e30.e30.e30"]) {
    const verdict = await v.verify(t);
    assert.equal(verdict.ok, false, t.slice(0, 20));
    assert.equal(!verdict.ok && verdict.status, 401);
  }
});

test("bearerToken extracts only a well-formed Bearer header", () => {
  assert.equal(bearerToken("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(bearerToken("bearer abc"), null);
  assert.equal(bearerToken("Basic abc"), null);
  assert.equal(bearerToken("Bearer a b"), null);
  assert.equal(bearerToken(undefined), null);
  assert.ok(ISSUER.length > 0);
});
