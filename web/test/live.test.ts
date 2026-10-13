// @vitest-environment node
import { describe, expect, it } from "vitest";
import { reevaluate } from "../src/banner/BannerPage.tsx";
import { loadBanner } from "../src/banner/load.ts";
import { sourceUri } from "../src/banner/model.ts";
import { loadPatient } from "../src/patient.ts";
import { SORT_COLUMNS, buildSearch, defaultQuery, flowMetrics, type FlowQuery, type SortColumn } from "../src/flowsheet/query.ts";
import { FhirClient } from "../src/fhir/client.ts";
import type { Observation } from "../src/fhir/types.ts";
import { config, contract } from "./support.ts";

/**
 * Read-only check of the banner's data path against the live POC HAPI with a real clinician token. Skipped (and
 * reported skipped) unless POC_WEB_LIVE=1: run `make test-web-live`, which supplies the password from the git-ignored
 * idp/.env.local and trusts the POC CA. It writes nothing.
 */
const live = process.env["POC_WEB_LIVE"] === "1";
const issuer = process.env["POC_ISSUER_URL"] ?? "https://macpro16.local:8444/realms/poc";
const fhirBase = process.env["POC_FHIR_URL"] ?? "https://macpro16.local:8443/fhir";

async function clinicianToken(): Promise<string> {
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password", client_id: "poc-devtest", username: "clinician-user",
      password: process.env["POC_CLINICIAN_USER_PASSWORD"] ?? "",
    }),
  });
  if (response.status !== 200) throw new Error(`token request failed (HTTP ${response.status}); is the stack up?`);
  return ((await response.json()) as { access_token: string }).access_token;
}

describe.skipIf(!live)("banner against the live HAPI", () => {
  it("shows the latest value per metric, as an independent sorted search finds it, and the staleness follows the clock", async () => {
    const token = await clinicianToken();
    const client = new FhirClient(fhirBase, async () => token);
    const live = { ...config, patientIdentifier: process.env["POC_PATIENT_IDENTIFIER"] ?? "poc-0001" };
    const patient = await loadPatient(client, live, contract);
    const model = await loadBanner(client, live, contract, new Date(), patient);

    expect(model.patientIdentifier).toBe(live.patientIdentifier);
    expect(model.values.length).toBeGreaterThan(0); // the stack has synthetic data (M8, M9 live runs)
    // HAPI writes meta.source as '<uri>#<request id>': the banner must still recognise the synthetic source
    expect(model.sources).toContain("synthetic");

    // Independent: read EVERY Observation of the metric (paged, unsorted) and take the newest in this process,
    // so the check does not rely on the server's sort that the app itself uses.
    const patientId = (await client.resources<{ id: string }>(
      `Patient?identifier=${encodeURIComponent(`${contract.patientIdentifierSystem}|${live.patientIdentifier}`)}`))[0]!.id;
    const readAll = async (first: string): Promise<Observation[]> => {
      const out: Observation[] = [];
      let url: string | null = first;
      for (let page = 0; url && page < 200; page++) {
        const response: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" } });
        const body = (await response.json()) as { entry?: { resource: Observation }[]; link?: { relation: string; url: string }[] };
        out.push(...(body.entry ?? []).map((e) => e.resource));
        url = body.link?.find((l) => l.relation === "next")?.url ?? null;
      }
      return out;
    };
    for (const v of model.values) {
      const metric = contract.quantityMetrics.find((m) => m.id === v.metricId)!;
      const code = encodeURIComponent(`${contract.loincSystem}|${metric.loincCode}`);
      const all = await readAll(
        `${fhirBase}/Observation?patient=Patient/${patientId}&code=${code}&_count=200&_elements=effectiveDateTime,valueQuantity`);
      const newest = Math.max(...all.map((o) => Date.parse(o.effectiveDateTime ?? "")));
      expect(Date.parse(v.effective)).toBe(newest);
      const valuesAtNewest = all.filter((o) => Date.parse(o.effectiveDateTime ?? "") === newest).map((o) => o.valueQuantity?.value);
      expect(valuesAtNewest).toContain(v.value);
      expect(v.unit).toBe(metric.unit);
    }

    // "Last data received" is the newest server receipt over everything for this patient.
    const everything = await readAll(`${fhirBase}/Observation?patient=Patient/${patientId}&_count=200&_elements=meta`);
    const newestReceipt = Math.max(...everything.map((o) => Date.parse(o.meta?.lastUpdated ?? "")));
    expect(Date.parse(model.lastReceivedAt as string)).toBe(newestReceipt);

    // Staleness follows the clock (the same stored model, evaluated at different times).
    const received = Date.parse(model.lastReceivedAt as string);
    const at = (minutes: number) => reevaluate(model, received + minutes * 60_000, config.staleAfterMinutes).staleness.state;
    expect(at(1)).toBe("current");
    expect(at(config.staleAfterMinutes + 1)).toBe("stale");
    // and the data on the server is old enough, or recent enough, that the banner says so truthfully right now
    expect(model.staleness.state).toBe(Date.now() - received > config.staleAfterMinutes * 60_000 ? "stale" : "current");
  }, 120_000);

  it("flowsheet queries match an independent read of every Observation: totals, no duplicates or gaps across pages, order", async () => {
    const token = await clinicianToken();
    const client = new FhirClient(fhirBase, async () => token);
    const patient = await loadPatient(client, { ...config, patientIdentifier: process.env["POC_PATIENT_IDENTIFIER"] ?? "poc-0001" }, contract);

    // Independent model: every Observation of the patient, read unfiltered and unsorted, filtered and ordered here.
    const all: Observation[] = [];
    let url: string | null = `${fhirBase}/Observation?patient=Patient/${patient.id}&_count=200`;
    for (let page = 0; url && page < 500; page++) {
      const response: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" } });
      const body = (await response.json()) as { entry?: { resource: Observation }[]; link?: { relation: string; url: string }[] };
      all.push(...(body.entry ?? []).map((e) => e.resource));
      url = body.link?.find((l) => l.relation === "next")?.url ?? null;
    }
    expect(all.length).toBeGreaterThan(2000); // "thousands of rows" (the seeded synthetic data)

    const metrics = flowMetrics(contract);
    const instant = (o: Observation) => Date.parse(o.effectiveDateTime ?? o.effectivePeriod?.start ?? "");
    const codeOf = (o: Observation) => o.code?.coding?.find((c) => c.system === contract.loincSystem)?.code ?? "";
    const keyOf = (o: Observation, column: SortColumn): number | string => {
      switch (column) {
        case "measured": return instant(o);
        case "metric": return codeOf(o);
        case "value": return o.valueQuantity?.value ?? Number.NEGATIVE_INFINITY;
        case "status": return o.status ?? "";
        case "received": return Date.parse(o.meta?.lastUpdated ?? "");
      }
    };
    const expected = (q: FlowQuery): Observation[] => {
      const chosen = new Set((q.metrics.length === 0 ? metrics : metrics.filter((m) => q.metrics.includes(m.key))).map((m) => m.code));
      const from = q.from === null ? -Infinity : Date.parse(`${q.from}T00:00:00Z`);
      const to = q.to === null ? Infinity : Date.parse(`${q.to}T00:00:00Z`) + 86_400_000;
      return all.filter((o) =>
        chosen.has(codeOf(o)) && instant(o) >= from && instant(o) < to &&
        (q.source === "any" || sourceUri(o.meta?.source) === contract.metaSource[q.source]) &&
        (q.status === "any" || o.status === q.status));
    };

    const base: FlowQuery = { ...defaultQuery, pageSize: 100 };
    const combos: [string, FlowQuery][] = [
      ["default", base],
      ["heart rate only", { ...base, metrics: ["heartRate"] }],
      ["hrv + resting", { ...base, metrics: ["hrvSdnn", "restingHeartRate"] }],
      ["sleep stages only", { ...base, metrics: contract.sleepStages.map((s) => s.id) }],
      ["date range", { ...base, from: "2005-01-01", to: "2007-12-31" }],
      ["single day", { ...base, from: "2026-10-11", to: "2026-10-11" }],
      ["synthetic source", { ...base, source: "synthetic" }],
      ["healthKit source (none expected)", { ...base, source: "healthKit" }],
      ["preliminary", { ...base, status: "preliminary" }],
      ["entered-in-error", { ...base, status: "entered-in-error" }],
      ["combined", { ...base, metrics: ["heartRate"], from: "2003-01-01", to: "2010-12-31", source: "synthetic", status: "final" }],
      ...SORT_COLUMNS.flatMap((column): [string, FlowQuery][] => (["asc", "desc"] as const).map((direction) =>
        [`sort ${column} ${direction}`, { ...base, sort: { column, direction } }])),
    ];

    for (const [name, q] of combos) {
      const want = expected(q);
      const got: Observation[] = [];
      let total = -1;
      for (let page = 0; page < 200; page++) {
        const bundle = await client.search<Observation>(buildSearch({ ...q, page }, patient.id, contract));
        total = bundle.total ?? -1;
        const rows = (bundle.entry ?? []).flatMap((e) => (e.resource ? [e.resource] : []));
        got.push(...rows);
        if (rows.length < q.pageSize) break;
      }
      expect(total, `${name}: total`).toBe(want.length);
      expect(got.length, `${name}: rows read`).toBe(want.length);
      expect(new Set(got.map((o) => o.id)).size, `${name}: no duplicates`).toBe(got.length);
      expect(new Set(got.map((o) => o.id)), `${name}: same set`).toEqual(new Set(want.map((o) => o.id)));
      const keys = got.map((o) => keyOf(o, q.sort.column));
      const sign = q.sort.direction === "asc" ? 1 : -1;
      const ordered = keys.every((k, i) => i === 0 || (k === keys[i - 1] || (k > keys[i - 1]! ? 1 : -1) === sign));
      expect(ordered, `${name}: ordered ${q.sort.column} ${q.sort.direction}`).toBe(true);
    }
    // positive controls: the independent model does distinguish things (non-empty, and filters really narrow)
    expect(expected(base).length).toBe(all.filter((o) => metrics.some((m) => m.code === codeOf(o))).length);
    expect(expected({ ...base, status: "preliminary" }).length).toBeGreaterThan(0);
    expect(expected({ ...base, metrics: ["heartRate"] }).length).toBeLessThan(expected(base).length);
  }, 600_000);
});
