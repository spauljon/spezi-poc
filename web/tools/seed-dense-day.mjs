// Seeds ONE dense synthetic day into the POC HAPI, for verifying the intraday view (M15). Synthetic data only, written
// as the synthetic capture user by conditional create on a fixed identifier: running it again changes nothing.
//
//   make web-seed-dense-day            (reads the capture user's password from the git-ignored idp/.env.local)
//
// The day (UTC) holds heart rate every 4 s (21,600 slots) with three pauses, a short pause below the gap threshold, six
// samples that carry a stored `artifact-suspected` flag, and two implausible values that carry NO flag; plus HRV every
// 30 min. Everything the view must get right has a case here and a control next to it (see web/test/live.test.ts).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const contract = JSON.parse(readFileSync(`${here}../../contract/metrics.json`, "utf8"));
const issuer = process.env.POC_ISSUER_URL ?? "https://macpro16.local:8444/realms/poc";
const fhir = process.env.POC_FHIR_URL ?? "https://macpro16.local:8443/fhir";
const patientIdentifier = process.env.POC_PATIENT_IDENTIFIER ?? "poc-0001";
const DAY = process.env.POC_DENSE_DAY ?? "2026-09-25";
const password = process.env.POC_CAPTURE_USER_PASSWORD;
if (!password) throw new Error("POC_CAPTURE_USER_PASSWORD is not set (run through `make web-seed-dense-day`)");
if (!/^\d{4}-\d{2}-\d{2}$/.test(DAY)) throw new Error("POC_DENSE_DAY must be YYYY-MM-DD");

const metric = (id) => contract.metrics.find((m) => m.id === id);
const hr = metric("heartRate");
const hrv = metric("hrvSdnn");
const system = contract.systems.identifier.synthetic;
const flag = { system: contract.systems.dataQualityFlag, code: contract.dataQualityFlags.artifactSuspected };

// the plan the live test checks against: minute-of-day ranges with no samples, and the stored/unstored oddities
export const PLAN = {
  day: DAY,
  cadenceSeconds: 4,
  gaps: [[130, 167], [665, 680], [1180, 1242]], // [startMinute, endMinute): 37, 15 and 62 minutes
  shortPause: [840, 844], // 4 minutes: below the 10-minute floor, so NOT a gap
  flagged: [[300, 0, 250], [300, 4, 25], [610, 20, 280], [700, 0, 270], [905, 8, 240], [1310, 0, 30]], // [minute, second, value]
  unflaggedImplausible: [[495, 4, 235], [1000, 8, 28]],
};

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const inAny = (m, ranges) => ranges.some(([a, b]) => m >= a && m < b);
const fixed = new Map([...PLAN.flagged.map(([m, s, v]) => [`${m}:${s}`, { v, flagged: true }]),
  ...PLAN.unflaggedImplausible.map(([m, s, v]) => [`${m}:${s}`, { v, flagged: false }])]);

export function buildObservations(patientId) {
  const out = [];
  const random = rng(4242);
  const start = Date.parse(`${DAY}T00:00:00Z`);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "+00:00");
  const make = (m, idValue, ms, value, flagged) => ({
    identifier: idValue,
    resource: {
      resourceType: "Observation",
      meta: { source: contract.systems.metaSource.synthetic, ...(flagged ? { tag: [flag] } : {}) },
      identifier: [{ system, value: idValue }],
      status: "final",
      category: [{ coding: [{ system: contract.systems.observationCategory, code: m.category }] }],
      code: { coding: [{ system: contract.systems.loinc, code: m.loinc.code }] },
      subject: { reference: `Patient/${patientId}` },
      effectiveDateTime: iso(ms),
      valueQuantity: { value, unit: m.unit.ucum, system: contract.systems.ucum, code: m.unit.ucum },
    },
  });
  const perMinute = 60 / PLAN.cadenceSeconds;
  for (let minute = 0; minute < 1440; minute++) {
    if (inAny(minute, PLAN.gaps) || (minute >= PLAN.shortPause[0] && minute < PLAN.shortPause[1])) continue;
    for (let k = 0; k < perMinute; k++) {
      const second = k * PLAN.cadenceSeconds;
      const odd = fixed.get(`${minute}:${second}`);
      const circadian = 64 + 10 * Math.sin(((minute - 240) / 1440) * 2 * Math.PI);
      const exercise = minute >= 1020 && minute < 1050 ? 45 * Math.sin(((minute - 1020) / 30) * Math.PI) : 0;
      const value = odd ? odd.v : Math.round((circadian + exercise + (random() - 0.5) * 8) * 10) / 10;
      out.push(make(hr, `dense-${DAY}-hr-${minute * 100 + second}`, start + (minute * 60 + second) * 1000, value, odd?.flagged === true));
    }
  }
  for (let i = 0; i < 48; i++) {
    out.push(make(hrv, `dense-${DAY}-hrv-${i}`, start + i * 30 * 60_000, Math.round((45 + 12 * Math.sin(i / 7) + (random() - 0.5) * 6) * 10) / 10, false));
  }
  return out;
}

async function token() {
  const r = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "poc-devtest", username: "capture-user", password }),
  });
  if (r.status !== 200) throw new Error(`token request failed (HTTP ${r.status}); is the stack up?`);
  return (await r.json()).access_token;
}

async function main() {
  const tok = await token();
  const headers = { Authorization: `Bearer ${tok}`, "Content-Type": "application/fhir+json", Accept: "application/fhir+json" };
  const q = encodeURIComponent(`${contract.systems.identifier.patient}|${patientIdentifier}`);
  const found = await (await fetch(`${fhir}/Patient?identifier=${q}`, { headers })).json();
  const patientId = found.entry?.[0]?.resource?.id;
  if (!patientId) throw new Error("the synthetic patient was not found (python3 hapi/auth.py seed)");

  const all = buildObservations(patientId);
  const SIZE = 250;
  const bundles = [];
  for (let i = 0; i < all.length; i += SIZE) bundles.push(all.slice(i, i + SIZE));
  let created = 0, existing = 0, failed = 0, done = 0;
  const started = Date.now();
  const worker = async (queue) => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const body = {
        resourceType: "Bundle", type: "transaction",
        entry: b.map((o) => ({
          // required by request validation when an entry holds a relative reference (Patient/<id>)
          fullUrl: `urn:uuid:${randomUUID()}`,
          resource: o.resource,
          request: { method: "POST", url: "Observation", ifNoneExist: `identifier=${encodeURIComponent(`${system}|${o.identifier}`)}` },
        })),
      };
      const r = await fetch(fhir, { method: "POST", headers, body: JSON.stringify(body) });
      if (r.status !== 200) { failed += b.length; console.error(`bundle failed: HTTP ${r.status}`); continue; }
      for (const e of (await r.json()).entry ?? []) {
        if (String(e.response?.status).startsWith("201")) created++; else existing++;
      }
      done++;
      if (done % 10 === 0) process.stdout.write(`\r${done}/${bundles.length} bundles`);
    }
  };
  const queue = [...bundles];
  await Promise.all([worker(queue), worker(queue), worker(queue), worker(queue)]);
  process.stdout.write("\n");
  console.log(`dense day ${DAY}: ${all.length} Observations planned; ${created} created, ${existing} already there, ${failed} failed (${((Date.now() - started) / 1000).toFixed(0)} s)`);
  if (failed > 0) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
