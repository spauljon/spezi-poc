import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { ClientCredentials } from "../src/auth.ts";
import { HapiClient } from "../src/fhir.ts";
import { OracleStore } from "../src/oracle-store.ts";
import type { Window } from "../src/store.ts";
import { RollupWorker } from "../src/worker.ts";
import { contract, heartRate } from "./support.ts";

/**
 * End to end against the live POC stack (HAPI over TLS, Keycloak, Oracle). Skipped unless POC_ANALYTICS_LIVE=1;
 * run it with `make test-analytics-live`, which supplies the credentials from the git-ignored env files.
 *
 * Isolation: every sample falls on days in a random year between 2001 and 2015, so the days are this run's alone;
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
  const year = 2001 + (randomBytes(1)[0]! % 15);
  const tue = `${year}-03-10`, wed = `${year}-03-11`;
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
