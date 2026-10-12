import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AnalyticApi, MAX_RANGE_DAYS, type ApiResponse } from "../src/api.ts";
import type { Rollup } from "../src/store.ts";
import { MemoryStore } from "../src/store.ts";
import { buildSessions } from "../src/sleep.ts";
import { ISSUER, jwksServer, mint, newKey, verifierFor } from "./jwt-support.ts";
import { contract } from "./support.ts";

const key = newKey("api-key");
const ORIGIN = "https://macpro16.local:3000";

async function setup() {
  const store = new MemoryStore(() => Date.parse("2026-10-12T12:00:00Z"));
  const api = new AnalyticApi({
    contract, reader: store, verifier: verifierFor(jwksServer([key])), workerName: "w", corsOrigin: ORIGIN,
    now: () => Date.parse("2026-10-12T12:30:00Z"),
  });
  const get = (path: string, headers: Record<string, string | undefined> = {}, method = "GET"): Promise<ApiResponse> =>
    api.handle({ method, url: path, headers: { authorization: `Bearer ${mint({ key })}`, ...headers } });
  return { store, api, get };
}

const day = (patientId: string, metricId: string, d: string, v: number, n = 3): [{ patientId: string; metricId: string; day: string }, Rollup] =>
  [{ patientId, metricId, day: d }, { patientId, metricId, day: d, unit: "/min", n, min: v - 5, median: v, max: v + 5 }];

test("bands: returns the stored rows for the range, in order, with their values", async () => {
  const { store, get } = await setup();
  for (const [w, r] of [day("p1", "heartRate", "2026-10-02", 70), day("p1", "heartRate", "2026-10-01", 60), day("p1", "heartRate", "2026-10-09", 99),
                        day("p2", "heartRate", "2026-10-02", 10), day("p1", "hrvSdnn", "2026-10-02", 40)]) {
    await store.applyRollup(w, r);
  }
  const res = await get("/v1/patients/p1/bands?metric=heartRate&from=2026-10-01&to=2026-10-03");
  assert.equal(res.status, 200);
  const body = res.body as { bands: { day: string; median: number; revision: number }[]; metric: { unit: string } };
  assert.deepEqual(body.bands.map((b) => [b.day, b.median, b.revision]), [["2026-10-01", 60, 1], ["2026-10-02", 70, 1]]);
  assert.equal(body.metric.unit, "/min");
  assert.equal(res.headers["Cache-Control"], "no-store");
});

test("bands completeness: missing days, pending windows, last computed and the watermark are reported", async () => {
  const { store, get } = await setup();
  const [w, r] = day("p1", "heartRate", "2026-10-01", 60);
  await store.applyRollup(w, r);
  await store.recordTouched("w", [{ patientId: "p1", metricId: "heartRate", day: "2026-10-03" }], Date.parse("2026-10-12T11:59:00Z"));
  const res = await get("/v1/patients/p1/bands?metric=heartRate&from=2026-10-01&to=2026-10-04");
  const c = (res.body as { completeness: Record<string, unknown> }).completeness;
  assert.deepEqual(c, {
    requestedDays: 4, daysWithData: 1, missingDays: ["2026-10-02", "2026-10-03", "2026-10-04"], pendingWindows: 1,
    lastComputedAt: "2026-10-12T12:00:00.000Z", workerWatermark: "2026-10-12T11:59:00.000Z",
    generatedAt: "2026-10-12T12:30:00.000Z",
  });
});

test("completeness with no data at all: lastComputedAt and watermark are null, never invented", async () => {
  const { get } = await setup();
  const res = await get("/v1/patients/nobody/bands?metric=heartRate&from=2026-10-01&to=2026-10-01");
  const body = res.body as { bands: unknown[]; completeness: { lastComputedAt: unknown; workerWatermark: unknown; daysWithData: number } };
  assert.deepEqual(body.bands, []);
  assert.deepEqual([body.completeness.lastComputedAt, body.completeness.workerWatermark, body.completeness.daysWithData], [null, null, 0]);
});

test("sleep: sessions of the night range with their stage totals, nap flagged", async () => {
  const { store, get } = await setup();
  const T = Date.parse("2026-10-06T23:00:00Z");
  const interval = (id: string, stage: string, a: number, b: number) => ({ id, stage, startMs: T + a * 60_000, endMs: T + b * 60_000 });
  const sessions = buildSessions("p1", [
    interval("a", "asleepCore", 0, 60), interval("b", "asleepDeep", 60, 180), interval("c", "awake", 180, 190),
    interval("d", "asleepCore", 600, 660), // a nap many hours later, same UTC date as the night's waking? 09:00-10:00 on the 7th
  ]);
  await store.applyNights({ patientId: "p1", metricId: "sleepStage", day: "2026-10-07" }, sessions.filter((s) => s.night === "2026-10-07"));
  const res = await get("/v1/patients/p1/sleep?from=2026-10-07&to=2026-10-07");
  assert.equal(res.status, 200);
  const body = res.body as { sessions: { isMain: boolean; asleepMin: number; deepMin: number; awakenings: number }[] };
  assert.equal(body.sessions.length, 2);
  const main = body.sessions.find((s) => s.isMain)!;
  assert.deepEqual([main.asleepMin, main.deepMin, main.awakenings], [180, 120, 0]);
  assert.equal(body.sessions.filter((s) => !s.isMain).length, 1);
});

test("authentication comes first: no token and a bad token are 401 for every route, even unknown ones", async () => {
  const { api } = await setup();
  for (const path of ["/v1/metrics", "/v1/patients/p1/bands?metric=heartRate&from=2026-10-01&to=2026-10-02", "/nothing/here"]) {
    const none = await api.handle({ method: "GET", url: path, headers: {} });
    assert.equal(none.status, 401, path);
    assert.match(none.headers["WWW-Authenticate"] ?? "", /^Bearer/);
    const bad = await api.handle({ method: "GET", url: path, headers: { authorization: "Bearer not.a.token" } });
    assert.equal(bad.status, 401, path);
  }
});

test("wrong audience (HAPI's) is 401 and a missing role is 403; the right token is 200 (control)", async () => {
  const { api } = await setup();
  const call = (claims: Record<string, unknown>) =>
    api.handle({ method: "GET", url: "/v1/metrics", headers: { authorization: `Bearer ${mint({ key, claims })}` } });
  assert.equal((await call({})).status, 200);
  assert.equal((await call({ aud: ["hapi-fhir"] })).status, 401);
  assert.equal((await call({ roles: ["worker-reader"] })).status, 403);
  assert.equal((await call({ roles: ["capture-writer"] })).status, 403);
  assert.equal((await call({ iss: `${ISSUER}x` })).status, 401);
});

test("input validation: each bad parameter is a 400 for its own reason", async () => {
  const { get } = await setup();
  const base = "/v1/patients/p1/bands?metric=heartRate&from=2026-10-01&to=2026-10-02";
  assert.equal((await get(base)).status, 200); // control
  const cases: [string, RegExp][] = [
    ["/v1/patients/p1/bands?metric=nope&from=2026-10-01&to=2026-10-02", /metric/],
    ["/v1/patients/p1/bands?from=2026-10-01&to=2026-10-02", /metric/],
    ["/v1/patients/p1/bands?metric=heartRate&to=2026-10-02", /from/],
    ["/v1/patients/p1/bands?metric=heartRate&from=2026-13-01&to=2026-10-02", /from/],
    ["/v1/patients/p1/bands?metric=heartRate&from=2026-10-03&to=2026-10-02", /after/],
    [`/v1/patients/p1/bands?metric=heartRate&from=2025-01-01&to=2026-12-31`, new RegExp(String(MAX_RANGE_DAYS))],
    ["/v1/patients/p%2F1/bands?metric=heartRate&from=2026-10-01&to=2026-10-02", /patient id/],
  ];
  for (const [path, expected] of cases) {
    const res = await get(path);
    assert.equal(res.status, 400, path);
    assert.match((res.body as { detail: string }).detail, expected, path);
  }
  assert.equal((await get("/v1/patients/p1/bands%ZZ")).status, 400);
  // a dot segment is normalized away by the URL parser and lands on a route that does not exist: never a patient id
  assert.equal((await get("/v1/patients/%2e%2e/bands?metric=heartRate&from=2026-10-01&to=2026-10-02")).status, 404);
});

test("the range limit is inclusive: exactly 366 days is accepted, 367 is not", async () => {
  const { get } = await setup();
  assert.equal((await get("/v1/patients/p1/bands?metric=heartRate&from=2025-10-12&to=2026-10-12")).status, 200); // 366 days
  assert.equal((await get("/v1/patients/p1/bands?metric=heartRate&from=2025-10-11&to=2026-10-12")).status, 400); // 367
});

test("methods other than GET are 405, unknown paths are 404 (once authenticated)", async () => {
  const { get } = await setup();
  assert.equal((await get("/v1/metrics", {}, "POST")).status, 405);
  assert.equal((await get("/v1/metrics", {}, "DELETE")).status, 405);
  assert.equal((await get("/v1/unknown")).status, 404);
  assert.equal((await get("/v1/patients/p1")).status, 404);
});

test("CORS: only the configured origin gets headers; preflight needs no token; another origin is refused", async () => {
  const { api, get } = await setup();
  const allowed = await get("/v1/metrics", { origin: ORIGIN });
  assert.equal(allowed.headers["Access-Control-Allow-Origin"], ORIGIN);
  const other = await get("/v1/metrics", { origin: "https://evil.example" });
  assert.equal(other.headers["Access-Control-Allow-Origin"], undefined);
  const pre = await api.handle({ method: "OPTIONS", url: "/v1/metrics", headers: { origin: ORIGIN } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers["Access-Control-Allow-Headers"], "Authorization");
  const refused = await api.handle({ method: "OPTIONS", url: "/v1/metrics", headers: { origin: "https://evil.example" } });
  assert.equal(refused.status, 403);
});

test("metrics lists exactly the contract's quantity metrics", async () => {
  const { get } = await setup();
  const body = (await get("/v1/metrics")).body as { contractVersion: string; metrics: { id: string; unit: string; display: string }[] };
  assert.deepEqual(body.metrics.map((m) => [m.id, m.unit]), contract.quantityMetrics.map((m) => [m.id, m.ucum]));
  assert.equal(body.contractVersion, contract.version);
});

// ---- the API description is a contract: responses must match it ----

interface Schema {
  $ref?: string; type?: string | string[]; required?: string[]; properties?: Record<string, Schema>; items?: Schema;
}
const spec = JSON.parse(readFileSync(fileURLToPath(new URL("../api/openapi.json", import.meta.url)), "utf8")) as {
  paths: Record<string, unknown>; components: { schemas: Record<string, Schema> };
};

/** Minimal JSON-schema check for the subset the description uses; returns problems (empty when it conforms). */
function conforms(value: unknown, schema: Schema, at = "$"): string[] {
  if (schema.$ref) {
    return conforms(value, spec.components.schemas[schema.$ref.split("/").pop()!]!, at);
  }
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  const ok = types.length === 0 || types.some((t) => t === actual || (t === "number" && actual === "integer"));
  if (!ok) {
    return [`${at}: expected ${types.join("|")}, got ${actual}`];
  }
  const problems: string[] = [];
  if (actual === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) {
      if (!(k in obj)) problems.push(`${at}.${k}: required but missing`);
    }
    for (const k of Object.keys(obj)) {
      if (schema.properties && !(k in schema.properties)) problems.push(`${at}.${k}: not described`);
    }
    for (const [k, s] of Object.entries(schema.properties ?? {})) {
      if (k in obj) problems.push(...conforms(obj[k], s, `${at}.${k}`));
    }
  }
  if (actual === "array" && schema.items) {
    (value as unknown[]).forEach((v, i) => problems.push(...conforms(v, schema.items!, `${at}[${i}]`)));
  }
  return problems;
}

test("every 200 response conforms to the API description, and the description names exactly the routes served", async () => {
  const { store, get } = await setup();
  const [w, r] = day("p1", "heartRate", "2026-10-01", 60);
  await store.applyRollup(w, r);
  const T = Date.parse("2026-10-06T23:00:00Z");
  const sessions = buildSessions("p1", [
    { id: "a", stage: "asleepCore", startMs: T, endMs: T + 3_600_000 }, { id: "b", stage: "awake", startMs: T + 3_600_000, endMs: T + 3_900_000 },
    { id: "c", stage: "asleepREM", startMs: T + 3_900_000, endMs: T + 7_200_000 },
  ]);
  await store.applyNights({ patientId: "p1", metricId: "sleepStage", day: sessions[0]!.night }, sessions);

  const checks: [string, string][] = [
    ["/v1/metrics", "Metrics"],
    ["/v1/patients/p1/bands?metric=heartRate&from=2026-10-01&to=2026-10-02", "Bands"],
    [`/v1/patients/p1/sleep?from=${sessions[0]!.night}&to=${sessions[0]!.night}`, "Sleep"],
    ["/v1/patients/p1/bands?metric=heartRate&from=2026-10-09&to=2026-10-09", "Bands"],
  ];
  for (const [path, schema] of checks) {
    const res = await get(path);
    assert.equal(res.status, 200, path);
    assert.deepEqual(conforms(res.body, { $ref: `#/components/schemas/${schema}` }), [], path);
  }
  const errors = await get("/v1/patients/p1/bands?metric=zzz&from=2026-10-01&to=2026-10-01");
  assert.deepEqual(conforms(errors.body, { $ref: "#/components/schemas/Error" }), []);

  // positive control for the checker: a wrong shape is reported
  assert.notDeepEqual(conforms({ metrics: "x" }, { $ref: "#/components/schemas/Metrics" }), []);
  assert.deepEqual(Object.keys(spec.paths).sort(),
    ["/v1/metrics", "/v1/patients/{patientId}/bands", "/v1/patients/{patientId}/sleep"]);
});
