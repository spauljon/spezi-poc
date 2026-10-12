import assert from "node:assert/strict";
import { test } from "node:test";
import { ClientCredentials } from "../src/auth.ts";
import { HapiClient } from "../src/fhir.ts";

function tokenServer(expiresIn = 300) {
  const calls: { url: string; body: string }[] = [];
  let n = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body) });
    return new Response(JSON.stringify({ access_token: `tok-${++n}`, expires_in: expiresIn }), { status: 200 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("a token is reused until shortly before it expires, then renewed", async () => {
  const { calls, fetchImpl } = tokenServer(300);
  let now = 1_000_000;
  const c = new ClientCredentials("https://idp.test/realms/poc", "analytics-worker", "synthetic-secret", () => now, fetchImpl);
  assert.equal(await c.token(), "tok-1");
  now += 200_000; // 100 s left: still outside the 60 s skew
  assert.equal(await c.token(), "tok-1");
  assert.equal(calls.length, 1);
  now += 50_000; // 50 s left: inside the skew, renew
  assert.equal(await c.token(), "tok-2");
  assert.equal(calls.length, 2);
  assert.ok(calls[0]!.body.includes("grant_type=client_credentials"));
  assert.ok(calls[0]!.url.endsWith("/protocol/openid-connect/token"));
});

test("concurrent callers share one token request", async () => {
  const { calls, fetchImpl } = tokenServer();
  const c = new ClientCredentials("https://idp.test/realms/poc", "analytics-worker", "synthetic-secret", () => 0, fetchImpl);
  const results = await Promise.all([c.token(), c.token(), c.token()]);
  assert.deepEqual(new Set(results).size, 1);
  assert.equal(calls.length, 1);
});

test("a failed token request reports the status and never the secret", async () => {
  const fetchImpl = (async () => new Response("denied", { status: 401 })) as typeof fetch;
  const c = new ClientCredentials("https://idp.test/realms/poc", "analytics-worker", "synthetic-secret-value", () => 0, fetchImpl);
  await assert.rejects(c.token(), (e: Error) => /HTTP 401/.test(e.message) && !e.message.includes("synthetic-secret-value"));
});

test("searches carry the bearer token and ask the server not to reuse cached results", async () => {
  const seen: Headers[] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return new Response(JSON.stringify({ entry: [{ resource: { id: "a" } }] }), { status: 200 });
  }) as typeof fetch;
  const client = new HapiClient("https://fhir.test/fhir", async () => "tok", fetchImpl);
  const out: string[] = [];
  for await (const r of client.search("Observation?x=1")) out.push(r.id);
  assert.deepEqual(out, ["a"]);
  assert.equal(seen[0]!.get("authorization"), "Bearer tok");
  assert.equal(seen[0]!.get("cache-control"), "no-cache");
});

test("paging follows next links on the configured server and refuses any other", async () => {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    urls.push(String(url));
    const page = urls.length;
    const next = page === 1 ? "https://fhir.test/fhir?_getpages=abc" : page === 2 ? "https://evil.test/fhir?x=1" : undefined;
    return new Response(JSON.stringify({
      entry: [{ resource: { id: `r${page}` } }],
      link: next ? [{ relation: "next", url: next }] : [],
    }), { status: 200 });
  }) as typeof fetch;
  const client = new HapiClient("https://fhir.test/fhir", async () => "tok", fetchImpl);
  const got: string[] = [];
  await assert.rejects(async () => { for await (const r of client.search("Observation")) got.push(r.id); }, /outside the configured FHIR base/);
  assert.deepEqual(got, ["r1", "r2"]); // the in-server link was followed; the foreign one was not (and not fetched)
  assert.equal(urls.length, 2);
});

test("the FHIR base must be https", () => {
  assert.throws(() => new HapiClient("http://fhir.test/fhir", async () => "t"), /https/);
});
