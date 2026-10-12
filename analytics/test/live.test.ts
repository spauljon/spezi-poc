import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ClientCredentials } from "../src/auth.ts";
import { HapiClient } from "../src/fhir.ts";
import { OracleStore } from "../src/oracle-store.ts";
import type { Window } from "../src/store.ts";
import { RollupWorker } from "../src/worker.ts";
import { request } from "node:https";
import { homedir } from "node:os";
import { AnalyticApi } from "../src/api.ts";
import { JwtVerifier } from "../src/jwt.ts";
import { createApiServer, listen } from "../src/server.ts";
import { contract, heartRate } from "./support.ts";

const sleepMetric = contract.sleep!;
const codeOf = (stage: string) => [...sleepMetric.stageByCode].find(([, s]) => s === stage)![0];

/**
 * End to end against the live POC stack (HAPI over TLS, Keycloak, Oracle). Skipped unless POC_ANALYTICS_LIVE=1;
 * run it with `make test-analytics-live`, which supplies the credentials from the git-ignored env files.
 *
 * Isolation: every sample falls on a day (2001 to 2015) that the server confirms has no Observations near it (`freeDay`),
 * so the rows are this run's alone;
 * the worker gets a unique name and starts from "five minutes ago" so it scans only what this test wrote; and the
 * test removes its rollup rows and watermark afterwards. (The Observations stay in HAPI: no role can delete.)
 */
const live = process.env["POC_ANALYTICS_LIVE"] === "1";
const issuer = process.env["POC_ISSUER_URL"] ?? "https://macpro16.local:8444/realms/poc";
const fhirBase = process.env["POC_FHIR_BASE_URL"] ?? "https://macpro16.local:8443/fhir";
const patientSystem = "http://blueysoft.com/fhir/identifier/poc-patient";
const sampleSystem = "http://blueysoft.com/fhir/identifier/synthetic-sample";

function required(name: string): string {
  const v = process.env[name];
  assert.ok(v, `${name} is not set (run via make test-analytics-live)`);
  return v;
}

async function captureToken(): Promise<string> {
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password", client_id: "poc-devtest", username: "capture-user",
      password: required("POC_CAPTURE_USER_PASSWORD"),
    }),
  });
  assert.equal(response.status, 200, "could not get a capture token");
  return ((await response.json()) as { access_token: string }).access_token;
}

async function fhir(token: string, path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${fhirBase}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`, Accept: "application/fhir+json", "Cache-Control": "no-cache",
      ...(init.body ? { "Content-Type": "application/fhir+json" } : {}),
    },
  });
}


/**
 * A UTC date far in the past (2001 to 2015) with no Observation within 5 days either side of it on the server, so a
 * test's rows cannot include data left behind by an earlier run (HAPI keeps it: no role can delete). Checked on the
 * server, not assumed from randomness.
 */
async function freeDay(token: string): Promise<string> {
  const base = Date.UTC(2001, 0, 1);
  for (let attempt = 0; attempt < 50; attempt++) {
    const offset = randomBytes(2).readUInt16BE(0) % 5400;
    const start = base + (offset + 10) * 86_400_000;
    const from = new Date(start - 5 * 86_400_000).toISOString();
    const to = new Date(start + 5 * 86_400_000).toISOString();
    const body = (await (await fhir(token, `Observation?date=ge${from}&date=lt${to}&_summary=count`)).json()) as { total?: number };
    if (body.total === 0) {
      return new Date(start).toISOString().slice(0, 10);
    }
  }
  throw new Error("no free day found in 50 tries");
}

async function patientId(token: string): Promise<string> {
  const q = encodeURIComponent(`${patientSystem}|poc-0001`);
  const body = (await (await fhir(token, `Patient?identifier=${q}&_elements=id`)).json()) as { entry?: { resource: { id: string } }[] };
  assert.equal(body.entry?.length, 1, "expected the seeded POC patient (python3 hapi/auth.py seed)");
  return body.entry![0]!.resource.id;
}

/** Uploads heart-rate samples as one transaction of conditional creates (what the capture app does). */
async function upload(token: string, patient: string, tag: string, samples: { key: string; at: string; value: number }[]) {
  const entry = samples.map((s) => {
    const identifier = `syn-live-${tag}-${s.key}`;
    return {
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource: {
        resourceType: "Observation",
        identifier: [{ system: sampleSystem, value: identifier }],
        status: "final",
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }],
        code: { coding: [{ system: contract.loincSystem, code: heartRate.loincCode }] },
        subject: { reference: `Patient/${patient}` },
        effectiveDateTime: s.at,
        issued: new Date().toISOString(),
        valueQuantity: { value: s.value, unit: heartRate.ucum, system: contract.ucumSystem, code: heartRate.ucum },
      },
      request: {
        method: "POST", url: "Observation",
        ifNoneExist: `identifier=${encodeURIComponent(`${sampleSystem}|${identifier}`)}`,
      },
    };
  });
  const response = await fhir(token, "", { method: "POST", body: JSON.stringify({ resourceType: "Bundle", type: "transaction", entry }) });
  assert.equal(response.status, 200, `upload failed with HTTP ${response.status}`);
}

test("live: rollups are idempotent and a late sample changes only its own day", { skip: !live && "set POC_ANALYTICS_LIVE=1" }, async (t) => {
  const capture = await captureToken();
  const patient = await patientId(capture);
  const tag = randomBytes(4).toString("hex");
  const tue = await freeDay(capture);
  const wed = new Date(Date.parse(`${tue}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const windows: Window[] = [tue, wed].map((day) => ({ patientId: patient, metricId: "heartRate", day }));

  const store = await OracleStore.connect({
    user: required("ANALYTICS_DB_USER"), password: required("ANALYTICS_DB_PASSWORD"),
    connectString: process.env["POC_ANALYTICS_CONNECT"] ?? "127.0.0.1:1522/ANALYTICSPDB",
  });
  const name = `live-test-${tag}`;
  t.after(async () => {
    await store.purge(name, windows);
    await store.close();
  });

  // start the worker's clock just before this test's writes so it scans only them
  await store.recordTouched(name, [], Date.now() - 5 * 60_000);
  const credentials = new ClientCredentials(issuer, "analytics-worker", required("POC_WORKER_CLIENT_SECRET"));
  const worker = new RollupWorker({
    name, contract, store, fhir: new HapiClient(fhirBase, () => credentials.token()),
  });

  // Tuesday: three samples. 23:30-05:00 is 04:30 on WEDNESDAY in UTC, so Wednesday gets one and Tuesday two.
  await upload(capture, patient, tag, [
    { key: "a", at: `${tue}T08:00:00+00:00`, value: 60 },
    { key: "b", at: `${tue}T12:00:00+00:00`, value: 80 },
    { key: "c", at: `${tue}T23:30:00-05:00`, value: 100 },
  ]);

  const first = await worker.runOnce();
  assert.equal(first.scanned >= 3, true);
  const rows1 = (await store.rollups(patient)).filter((r) => windows.some((w) => w.day === r.day));
  assert.deepEqual(rows1.map((r) => [r.day, r.n, r.min, r.median, r.max, r.revision]),
    [[tue, 2, 60, 70, 80, 1], [wed, 1, 100, 100, 100, 1]]);

  // run again: same rows, same revisions (and the run really did re-read: positive control)
  const second = await worker.runOnce();
  assert.ok(second.recomputed > 0);
  assert.equal(second.changed, 0);
  assert.deepEqual((await store.rollups(patient)).filter((r) => windows.some((w) => w.day === r.day)), rows1);

  // a late Tuesday sample arrives (HAPI stamps it now): only Tuesday's row changes
  await upload(capture, patient, tag, [{ key: "d", at: `${tue}T20:00:00+00:00`, value: 120 }]);
  const third = await worker.runOnce();
  assert.equal(third.changed, 1);
  const rows3 = (await store.rollups(patient)).filter((r) => windows.some((w) => w.day === r.day));
  assert.deepEqual(rows3.map((r) => [r.day, r.n, r.min, r.median, r.max, r.revision]),
    [[tue, 3, 60, 80, 120, 2], [wed, 1, 100, 100, 100, 1]]);

  // resending the same sample (a duplicate delivery) is a no-op for the rollup
  await upload(capture, patient, tag, [{ key: "d", at: `${tue}T20:00:00+00:00`, value: 120 }]);
  const fourth = await worker.runOnce();
  assert.equal(fourth.changed, 0);
  assert.deepEqual((await store.rollups(patient)).filter((r) => windows.some((w) => w.day === r.day)), rows3);
});

test("live: the worker's token is refused by HAPI for anything but reads (positive control for the reader role)", { skip: !live && "set POC_ANALYTICS_LIVE=1" }, async () => {
  const credentials = new ClientCredentials(issuer, "analytics-worker", required("POC_WORKER_CLIENT_SECRET"));
  const token = await credentials.token();
  const read = await fhir(token, "Observation?_summary=count");
  assert.equal(read.status, 200);
  const write = await fhir(token, "Observation", {
    method: "POST",
    body: JSON.stringify({ resourceType: "Observation", status: "final", code: { text: "x" } }),
  });
  assert.equal(write.status, 403);
});

async function uploadSleep(token: string, patient: string, tag: string, stages: { key: string; stage: string; start: string; end: string }[]) {
  const entry = stages.map((s) => {
    const identifier = `syn-live-${tag}-sleep-${s.key}`;
    return {
      fullUrl: `urn:uuid:${crypto.randomUUID()}`,
      resource: {
        resourceType: "Observation",
        identifier: [{ system: sampleSystem, value: identifier }],
        status: "final",
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "activity" }] }],
        code: { coding: [{ system: contract.loincSystem, code: codeOf(s.stage) }] },
        subject: { reference: `Patient/${patient}` },
        effectivePeriod: { start: s.start, end: s.end },
        issued: new Date().toISOString(),
        valueQuantity: {
          value: (Date.parse(s.end) - Date.parse(s.start)) / 60_000, unit: "min",
          system: contract.ucumSystem, code: "min",
        },
      },
      request: { method: "POST", url: "Observation", ifNoneExist: `identifier=${encodeURIComponent(`${sampleSystem}|${identifier}`)}` },
    };
  });
  const response = await fhir(token, "", { method: "POST", body: JSON.stringify({ resourceType: "Bundle", type: "transaction", entry }) });
  assert.equal(response.status, 200, `sleep upload failed with HTTP ${response.status}`);
}

test("live: a night across UTC midnight is summarized, stable on rerun, and a late stage changes only that night", { skip: !live && "set POC_ANALYTICS_LIVE=1" }, async (t) => {
  const capture = await captureToken();
  const patient = await patientId(capture);
  const tag = randomBytes(4).toString("hex");
  const d0 = await freeDay(capture);
  const plus = (base: string, n: number) => new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const d1 = plus(d0, 1);
  const nightWindows: Window[] = [plus(d0, -1), d0, d1, plus(d0, 2), plus(d0, 3)].map((day) => ({
    patientId: patient, metricId: sleepMetric.id, day,
  }));
  const store = await OracleStore.connect({
    user: required("ANALYTICS_DB_USER"), password: required("ANALYTICS_DB_PASSWORD"),
    connectString: process.env["POC_ANALYTICS_CONNECT"] ?? "127.0.0.1:1522/ANALYTICSPDB",
  });
  const name = `live-sleep-${tag}`;
  t.after(async () => {
    await store.purge(name, nightWindows);
    await store.close();
  });
  await store.recordTouched(name, [], Date.now() - 5 * 60_000);
  const credentials = new ClientCredentials(issuer, "analytics-worker", required("POC_WORKER_CLIENT_SECRET"));
  const worker = new RollupWorker({ name, contract, store, fhir: new HapiClient(fhirBase, () => credentials.token()) });

  // 22:30 on d0 to 06:30 on d1, UTC; 30 awake before onset, 8 h of stages with one 6-minute awakening
  await uploadSleep(capture, patient, tag, [
    { key: "1", stage: "awake", start: `${d0}T22:30:00Z`, end: `${d0}T23:00:00Z` },
    { key: "2", stage: "asleepCore", start: `${d0}T23:00:00Z`, end: `${d1}T01:00:00Z` },
    { key: "3", stage: "asleepDeep", start: `${d1}T01:00:00Z`, end: `${d1}T02:00:00Z` },
    { key: "4", stage: "awake", start: `${d1}T02:00:00Z`, end: `${d1}T02:06:00Z` },
    { key: "5", stage: "asleepREM", start: `${d1}T02:06:00Z`, end: `${d1}T05:00:00Z` },
    { key: "6", stage: "asleepCore", start: `${d1}T05:00:00Z`, end: `${d1}T06:00:00Z` },
  ]);

  await worker.runOnce();
  const mine = async () => (await store.nights(patient)).filter((s) => nightWindows.some((w) => w.day === s.night));
  const first = await mine();
  assert.equal(first.length, 1);
  const s = first[0]!;
  assert.equal(s.night, d1);
  assert.deepEqual(
    [s.latencyMin, s.coreMin, s.deepMin, s.remMin, s.awakeMin, s.awakenings, s.asleepMin, s.isMain, s.revision],
    [30, 180, 60, 174, 6, 1, 414, true, 1],
  );

  const second = await worker.runOnce();
  assert.ok(second.recomputed > 0);
  assert.equal(second.changed, 0);
  assert.deepEqual(await mine(), first);

  // a late interval: 06:00-06:30 more core sleep (the phone delivered it hours later)
  await uploadSleep(capture, patient, tag, [
    { key: "7", stage: "asleepCore", start: `${d1}T06:00:00Z`, end: `${d1}T06:30:00Z` },
  ]);
  await worker.runOnce();
  const third = await mine();
  assert.equal(third.length, 1);
  assert.deepEqual([third[0]!.coreMin, third[0]!.asleepMin, third[0]!.revision], [210, 444, 2]);
});

async function userToken(user: string, passwordVar: string): Promise<string> {
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "poc-devtest", username: user, password: required(passwordVar) }),
  });
  assert.equal(response.status, 200, `could not get a token for ${user}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

/** One HTTPS request to the in-process API on loopback, validating its certificate as macpro16.local. */
function callApi(port: number, path: string, token?: string): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1", port, path, method: "GET", servername: "macpro16.local",
      headers: { Host: "macpro16.local", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : null });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("live: the API serves what Oracle holds, over TLS, to clinicians only", { skip: !live && "set POC_ANALYTICS_LIVE=1" }, async (t) => {
  const capture = await captureToken();
  const patient = await patientId(capture);
  const tag = randomBytes(4).toString("hex");
  const d0 = await freeDay(capture);
  const d1 = new Date(Date.parse(`${d0}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const windows: Window[] = [d0, d1].map((day) => ({ patientId: patient, metricId: "heartRate", day }));

  const store = await OracleStore.connect({
    user: required("ANALYTICS_DB_USER"), password: required("ANALYTICS_DB_PASSWORD"),
    connectString: process.env["POC_ANALYTICS_CONNECT"] ?? "127.0.0.1:1522/ANALYTICSPDB",
  });
  const name = `live-api-${tag}`;
  const tlsDir = `${process.env["POC_TLS_DIR"] ?? `${homedir()}/.poc-ca`}/analytics`;
  const options = { keyPath: `${tlsDir}/api.key`, certPath: `${tlsDir}/api.crt`, host: "127.0.0.1", port: 0 };
  const api = new AnalyticApi({
    contract, reader: store, workerName: name, corsOrigin: null,
    verifier: new JwtVerifier({ issuer, audience: "poc-analytics", role: "clinician-reader" }),
  });
  const server = createApiServer(api, options);
  await listen(server, options);
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await store.purge(name, windows);
    await store.close();
  });
  const port = (server.address() as { port: number }).port;

  await store.recordTouched(name, [], Date.now() - 5 * 60_000);
  await upload(capture, patient, tag, [
    { key: "a", at: `${d0}T08:00:00+00:00`, value: 58 },
    { key: "b", at: `${d0}T09:00:00+00:00`, value: 66 },
    { key: "c", at: `${d1}T09:00:00+00:00`, value: 71 },
  ]);
  const credentials = new ClientCredentials(issuer, "analytics-worker", required("POC_WORKER_CLIENT_SECRET"));
  const worker = new RollupWorker({ name, contract, store, fhir: new HapiClient(fhirBase, () => credentials.token()) });
  await worker.runOnce();

  const path = `/v1/patients/${patient}/bands?metric=heartRate&from=${d0}&to=${d1}`;
  const clinician = await userToken("clinician-user", "POC_CLINICIAN_USER_PASSWORD");

  // the right token: 200, and the body is exactly what Oracle holds (positive control for every refusal below)
  const ok = await callApi(port, path, clinician);
  assert.equal(ok.status, 200);
  const stored = (await store.rollups(patient)).filter((r) => windows.some((w) => w.day === r.day));
  const served = (ok.body as { bands: { day: string; n: number; min: number; median: number; max: number; revision: number }[] }).bands;
  assert.deepEqual(served, stored.map((r) => ({ day: r.day, n: r.n, min: r.min, median: r.median, max: r.max, revision: r.revision })));
  assert.deepEqual(served.map((b) => [b.day, b.n, b.min, b.median, b.max]), [[d0, 2, 58, 62, 66], [d1, 1, 71, 71, 71]]);
  const completeness = (ok.body as { completeness: { missingDays: string[]; workerWatermark: string | null; pendingWindows: number } }).completeness;
  assert.deepEqual(completeness.missingDays, []);
  assert.equal(completeness.pendingWindows, 0);
  assert.notEqual(completeness.workerWatermark, null);

  // no token: 401; a capture user's token (right audience, wrong role): 403; the worker's token (HAPI's audience): 401
  assert.equal((await callApi(port, path)).status, 401);
  assert.equal((await callApi(port, path, await userToken("capture-user", "POC_CAPTURE_USER_PASSWORD"))).status, 403);
  assert.equal((await callApi(port, path, await credentials.token())).status, 401);
  assert.equal((await callApi(port, path, `${clinician.slice(0, -3)}AAA`)).status, 401); // signature damaged
});
