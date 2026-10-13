// Shared by the seeding tools (synthetic data only; written as the synthetic capture user by conditional create).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
export const contract = JSON.parse(readFileSync(`${here}../../contract/metrics.json`, "utf8"));
export const issuer = process.env.POC_ISSUER_URL ?? "https://macpro16.local:8444/realms/poc";
export const fhir = process.env.POC_FHIR_URL ?? "https://macpro16.local:8443/fhir";
export const patientIdentifier = process.env.POC_PATIENT_IDENTIFIER ?? "poc-0001";
export const syntheticSystem = contract.systems.identifier.synthetic;
export const metric = (id) => contract.metrics.find((m) => m.id === id);

/** A dateTime in the contract's form: the numeric offset of the instant's own zone, never Z. */
export function withOffset(ms, timeZone = "America/Los_Angeles") {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMin = Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
  const sign = offsetMin < 0 ? "-" : "+";
  const abs = Math.abs(offsetMin);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${hh}:${mm}`;
}

export async function captureToken() {
  const password = process.env.POC_CAPTURE_USER_PASSWORD;
  if (!password) throw new Error("POC_CAPTURE_USER_PASSWORD is not set (run through the make target)");
  const r = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "poc-devtest", username: "capture-user", password }),
  });
  if (r.status !== 200) throw new Error(`token request failed (HTTP ${r.status}); is the stack up?`);
  return (await r.json()).access_token;
}

export async function findPatientId(tok) {
  const q = encodeURIComponent(`${contract.systems.identifier.patient}|${patientIdentifier}`);
  const r = await fetch(`${fhir}/Patient?identifier=${q}`, { headers: { Authorization: `Bearer ${tok}`, Accept: "application/fhir+json" } });
  const id = (await r.json()).entry?.[0]?.resource?.id;
  if (!id) throw new Error("the synthetic patient was not found (python3 hapi/auth.py seed)");
  return id;
}

/** POSTs [{identifier, resource}] as transaction bundles of conditional creates; returns counts. */
export async function postConditional(tok, items, { size = 250, concurrency = 4, onProgress } = {}) {
  const headers = { Authorization: `Bearer ${tok}`, "Content-Type": "application/fhir+json", Accept: "application/fhir+json" };
  const bundles = [];
  for (let i = 0; i < items.length; i += size) bundles.push(items.slice(i, i + size));
  let created = 0, existing = 0, failed = 0, done = 0;
  const queue = [...bundles];
  const worker = async () => {
    for (let b = queue.shift(); b; b = queue.shift()) {
      const body = {
        resourceType: "Bundle", type: "transaction",
        entry: b.map((o) => ({
          // required by request validation when an entry holds a relative reference (Patient/<id>)
          fullUrl: `urn:uuid:${randomUUID()}`,
          resource: o.resource,
          request: { method: "POST", url: "Observation", ifNoneExist: `identifier=${encodeURIComponent(`${syntheticSystem}|${o.identifier}`)}` },
        })),
      };
      const r = await fetch(fhir, { method: "POST", headers, body: JSON.stringify(body) });
      if (r.status !== 200) { failed += b.length; console.error(`bundle failed: HTTP ${r.status}`); continue; }
      for (const e of (await r.json()).entry ?? []) {
        if (String(e.response?.status).startsWith("201")) created++; else existing++;
      }
      done++;
      onProgress?.(done, bundles.length);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { created, existing, failed };
}
