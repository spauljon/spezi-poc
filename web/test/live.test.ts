// @vitest-environment node
import { request } from "node:https";
import { describe, expect, it } from "vitest";
import { reevaluate } from "../src/banner/BannerPage.tsx";
import { loadBanner } from "../src/banner/load.ts";
import { sourceUri } from "../src/banner/model.ts";
import { loadPatient } from "../src/patient.ts";
import { SORT_COLUMNS, buildSearch, defaultQuery, flowMetrics, type FlowQuery, type SortColumn } from "../src/flowsheet/query.ts";
import { FhirClient } from "../src/fhir/client.ts";
import { AnalyticsClient, AnalyticsError } from "../src/trends/client.ts";
import { buildChartData, compareMetrics, daysBetween, presetRange, todayUtc } from "../src/trends/model.ts";
import type { Observation } from "../src/fhir/types.ts";
import rawContract from "../../contract/metrics.json";
import { config, contract } from "./support.ts";

/**
 * Read-only check of the banner's data path against the live POC HAPI with a real clinician token. Skipped (and
 * reported skipped) unless POC_WEB_LIVE=1: run `make test-web-live`, which supplies the passwords from the git-ignored
 * idp/.env.local and trusts the POC CA. It only reads, except for two synthetic status fixtures that it ensures exist
 * (see ensureStatusFixtures).
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

/**
 * The flowsheet's status filter is only checked against a stack that holds rows with a status other than `final`
 * (the positive controls need them). A fresh stack has none, so two synthetic fixtures are created once, by
 * conditional create on a fixed identifier: running this again changes nothing. This is the one write in this file,
 * done as the synthetic capture user (the clinician role cannot write).
 */
async function ensureStatusFixtures(patientId: string): Promise<void> {
  const password = process.env["POC_CAPTURE_USER_PASSWORD"];
  if (!password) throw new Error("POC_CAPTURE_USER_PASSWORD is not set; run through `make test-web-live`");
  const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "poc-devtest", username: "capture-user", password }),
  });
  if (response.status !== 200) throw new Error(`capture token request failed (HTTP ${response.status})`);
  const token = ((await response.json()) as { access_token: string }).access_token;

  const heartRate = contract.quantityMetrics.find((m) => m.id === "heartRate")!;
  const system = (rawContract as { systems: { identifier: { synthetic: string } } }).systems.identifier.synthetic;
  const fixtures = [
    { status: "preliminary", id: "web-live-fixture-preliminary", at: "2026-01-02T12:00:00Z" },
    { status: "entered-in-error", id: "web-live-fixture-entered-in-error", at: "2026-01-02T12:01:00Z" },
  ];
  for (const f of fixtures) {
    const created = await fetch(`${fhirBase}/Observation`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/fhir+json",
        "If-None-Exist": `identifier=${encodeURIComponent(`${system}|${f.id}`)}`,
      },
      body: JSON.stringify({
        resourceType: "Observation",
        meta: { source: contract.metaSource.synthetic },
        identifier: [{ system, value: f.id }],
        status: f.status,
        category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }],
        code: { coding: [{ system: contract.loincSystem, code: heartRate.loincCode }] },
        subject: { reference: `Patient/${patientId}` },
        effectiveDateTime: f.at,
        valueQuantity: { value: 70, unit: heartRate.unit, system: "http://unitsofmeasure.org", code: heartRate.unit },
      }),
    });
    if (![200, 201].includes(created.status)) throw new Error(`could not ensure fixture ${f.id} (HTTP ${created.status})`);
  }
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
        `${fhirBase}/Observation?patient=Patient/${patientId}&code=${code}&_count=200&_elements=effectiveDateTime,effectivePeriod,valueQuantity`);
      // the banner's rule (M12): an instant is when it was measured; a period (resting heart rate: one per local day)
      // is measured when it ends
      const measured = (o: Observation) => Date.parse(o.effectiveDateTime ?? o.effectivePeriod?.end ?? o.effectivePeriod?.start ?? "");
      const newest = Math.max(...all.map(measured));
      expect(Date.parse(v.effective)).toBe(newest);
      const valuesAtNewest = all.filter((o) => measured(o) === newest).map((o) => o.valueQuantity?.value);
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
    await ensureStatusFixtures(patient.id);

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
    // HAPI's `date` search matches a PERIOD that overlaps the range (ge on its end, lt on its start); an instant is
    // just a period of no length. So a resting-heart-rate day that straddles a UTC midnight is in both days' results.
    const endOf = (o: Observation) => Date.parse(o.effectiveDateTime ?? o.effectivePeriod?.end ?? o.effectivePeriod?.start ?? "");
    const expected = (q: FlowQuery): Observation[] => {
      const chosen = new Set((q.metrics.length === 0 ? metrics : metrics.filter((m) => q.metrics.includes(m.key))).map((m) => m.code));
      const from = q.from === null ? -Infinity : Date.parse(`${q.from}T00:00:00Z`);
      const to = q.to === null ? Infinity : Date.parse(`${q.to}T00:00:00Z`) + 86_400_000;
      return all.filter((o) =>
        chosen.has(codeOf(o)) && endOf(o) >= from && instant(o) < to &&
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


/** The analytic API listens on loopback only: connect there, and validate its certificate as the POC host name. */
const apiPort = Number(process.env["POC_ANALYTICS_PORT"] ?? "8445");
const apiFetch: typeof fetch = (input, init) => new Promise((resolve, reject) => {
  const url = new URL(String(input), "https://macpro16.local");
  const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
  const req = request({
    host: "127.0.0.1", port: apiPort, path: `${url.pathname}${url.search}`, method: "GET", servername: "macpro16.local",
    headers: { Host: "macpro16.local", ...headers },
  }, (res) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 0 })));
  });
  req.on("error", reject);
  req.end();
});

describe.skipIf(!live)("trends against the live analytic API", () => {
  const median = (v: number[]): number => {
    const s = [...v].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 === 1 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
  };

  it("every band the chart would draw equals an independent computation from the raw Observations, and the gaps are the days with none", async () => {
    const token = await clinicianToken();
    const fhir = new FhirClient(fhirBase, async () => token);
    const patient = await loadPatient(fhir, { ...config, patientIdentifier: process.env["POC_PATIENT_IDENTIFIER"] ?? "poc-0001" }, contract);
    const api = new AnalyticsClient("https://macpro16.local", async () => token, apiFetch);

    // the service and this app agree on the metrics (units included)
    const offered = await api.metrics();
    expect(compareMetrics(offered.metrics, contract.quantityMetrics)).toEqual([]);

    const { from, to } = presetRange(90, todayUtc(new Date()));
    for (const m of contract.quantityMetrics) {
      const response = await api.bands(patient.id, m.id, from, to);
      expect(response.metric.unit).toBe(m.unit);

      // independent model: every Observation of this metric, read unsorted from HAPI and bucketed here by UTC day
      const code = encodeURIComponent(`${contract.loincSystem}|${m.loincCode}`);
      const values = new Map<string, number[]>();
      let url: string | null = `${fhirBase}/Observation?patient=Patient/${patient.id}&code=${code}&_count=200&_elements=effectiveDateTime,effectivePeriod,valueQuantity`;
      for (let page = 0; url && page < 500; page++) {
        const r: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" } });
        const body = (await r.json()) as { entry?: { resource: Observation }[]; link?: { relation: string; url: string }[] };
        for (const e of body.entry ?? []) {
          const t = e.resource.effectiveDateTime ?? e.resource.effectivePeriod?.start;
          const v = e.resource.valueQuantity?.value;
          if (!t || v === undefined) continue;
          const day = new Date(t).toISOString().slice(0, 10);
          if (day < from || day > to) continue;
          (values.get(day) ?? values.set(day, []).get(day)!).push(v);
        }
        url = body.link?.find((l) => l.relation === "next")?.url ?? null;
      }

      const data = buildChartData(response);
      expect(data.days).toEqual(daysBetween(from, to));
      let compared = 0;
      data.days.forEach((day, i) => {
        const v = values.get(day);
        if (!v) {
          expect(data.median[i], `${m.id} ${day}: a day with no Observations must be a gap`).toBeNull();
          return;
        }
        compared++;
        expect(data.n[i], `${m.id} ${day} n`).toBe(v.length);
        expect(data.min[i], `${m.id} ${day} min`).toBe(Math.min(...v));
        expect(data.max[i], `${m.id} ${day} max`).toBe(Math.max(...v));
        expect(data.median[i], `${m.id} ${day} median`).toBeCloseTo(median(v), 9);
      });
      expect(compared, `${m.id}: the live stack should hold synthetic data in the last 90 days`).toBeGreaterThan(0);
      // the API's own completeness block lists exactly the gaps the chart draws
      expect([...response.completeness.missingDays]).toEqual([...data.missing]);
    }
  }, 180_000);

  it("refuses a request without a token (positive control: the same request with one is served)", async () => {
    const token = await clinicianToken();
    const withToken = new AnalyticsClient("https://macpro16.local", async () => token, apiFetch);
    expect((await withToken.metrics()).metrics.length).toBeGreaterThan(0);

    const without = new AnalyticsClient("https://macpro16.local", async () => "", apiFetch);
    await expect(without.metrics()).rejects.toMatchObject({ kind: "unauthorized" });
    await expect(without.metrics()).rejects.toBeInstanceOf(AnalyticsError);
  });
});
