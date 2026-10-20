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
import { addDays, buildChartData, compareMetrics, daysBetween, presetRange, todayUtc } from "../src/trends/model.ts";
import { loadDay } from "../src/intraday/load.ts";
import { dayStart } from "../src/intraday/model.ts";
import { buildCells, mealKeys, withEntries } from "../src/nutrition/model.ts";
import { disagreement, loadNight } from "../src/sleep/load.ts";
import { clockNote, nightSummary, offsetsIn } from "../src/sleep/model.ts";
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

    // 500 a page (the sweep is about filters, order and offsets, not the UI's page size): with ~39k rows 100 a page is
    // ~400 requests per combination
    const base: FlowQuery = { ...defaultQuery, pageSize: 500 as FlowQuery["pageSize"] };
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
      const pageCap = Math.ceil(want.length / q.pageSize) + 3; // enough for every row, never unbounded
      for (let page = 0; page < pageCap; page++) {
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


describe.skipIf(!live)("intraday against the live HAPI (the dense synthetic day)", () => {
  type Plan = {
    day: string; cadenceSeconds: number; gaps: Array<[number, number]>; shortPause: [number, number];
    flagged: Array<[number, number, number]>; unflaggedImplausible: Array<[number, number, number]>;
  };

  it("the day the view loads equals an independent read of the raw Observations; gaps, stored flags and unflagged oddities are as seeded", async () => {
    // the seeded plan is the single description of what the day holds (web/tools/seed-dense-day.mjs)
    process.env["POC_CAPTURE_USER_PASSWORD"] ??= "unused-here";
    const { PLAN } = (await import(new URL("../tools/seed-dense-day.mjs", import.meta.url).href)) as { PLAN: Plan };
    const token = await clinicianToken();
    const fhir = new FhirClient(fhirBase, async () => token);
    const patient = await loadPatient(fhir, { ...config, patientIdentifier: process.env["POC_PATIENT_IDENTIFIER"] ?? "poc-0001" }, contract);
    const heart = contract.quantityMetrics.find((m) => m.id === "heartRate")!;

    const t0 = performance.now();
    const model = await loadDay(fhir, patient.id, heart, contract, PLAN.day, { now: new Date("2030-01-01T00:00:00Z") });
    const loadMs = performance.now() - t0;
    console.log(`intraday: ${model.n} heart-rate samples loaded and modelled in ${loadMs.toFixed(0)} ms`);
    expect(model.n, "the dense day is missing: run `make web-seed-dense-day`").toBeGreaterThan(17_000); // "a 17k-sample day"
    expect(loadMs).toBeLessThan(30_000);

    // independent model: every heart-rate Observation of the day, read unsorted in big pages and bucketed here
    const code = encodeURIComponent(`${contract.loincSystem}|${heart.loincCode}`);
    const patientRef = encodeURIComponent(`Patient/${patient.id}`);
    const day0 = dayStart(PLAN.day);
    const raw: Array<{ t: number; v: number; flagged: boolean }> = [];
    let url: string | null = `${fhirBase}/Observation?patient=${patientRef}&code=${code}&date=ge${PLAN.day}T00:00:00Z&date=lt${new Date(day0 + 86_400_000).toISOString().slice(0, 10)}T00:00:00Z&_count=2000&_elements=effectiveDateTime,valueQuantity,meta,status`;
    for (let page = 0; url && page < 100; page++) {
      const r: Response = await fetch(url, { headers: { Authorization: `Bearer ${token}`, "Cache-Control": "no-cache" } });
      const body = (await r.json()) as { entry?: { resource: Observation }[]; link?: { relation: string; url: string }[] };
      for (const e of body.entry ?? []) {
        const o = e.resource;
        if (o.status === "entered-in-error" || !o.effectiveDateTime || o.valueQuantity?.value === undefined) continue;
        raw.push({
          t: Date.parse(o.effectiveDateTime), v: o.valueQuantity.value,
          flagged: (o.meta?.tag ?? []).some((c) => c.system === contract.dataQualityFlag.system && c.code === contract.dataQualityFlag.artifactSuspected),
        });
      }
      url = body.link?.find((l) => l.relation === "next")?.url ?? null;
    }
    raw.sort((a, b) => a.t - b.t);
    expect(model.n).toBe(raw.length);
    expect(model.t).toEqual(raw.map((x) => x.t));
    expect(model.v).toEqual(raw.map((x) => x.v));
    expect(model.min).toBe(Math.min(...raw.map((x) => x.v)));
    expect(model.max).toBe(Math.max(...raw.map((x) => x.v)));
    expect(model.flagged).toEqual(raw.flatMap((x, i) => (x.flagged ? [i] : [])));

    // the seeded oddities, each with its control
    const at = (minute: number, second: number) => day0 + (minute * 60 + second) * 1000;
    const between = model.gaps.filter((g) => g.edge === null);
    expect(between).toHaveLength(PLAN.gaps.length);
    PLAN.gaps.forEach(([from, to], i) => {
      expect(between[i]!.start).toBe(at(from - 1, 60 - PLAN.cadenceSeconds)); // the last sample before the pause
      expect(between[i]!.end).toBe(at(to, 0)); // the first one after it
    });
    const [pauseFrom, pauseTo] = PLAN.shortPause;
    expect(between.some((g) => g.start < at(pauseTo, 0) && g.end > at(pauseFrom, 0)), "a 4-minute pause is not a gap").toBe(false);
    expect(model.gaps.filter((g) => g.edge !== null), "the day has samples at both ends").toHaveLength(0);

    const flaggedAt = new Set(model.flagged.map((i) => model.t[i]));
    for (const [minute, second, value] of PLAN.flagged) {
      const i = model.t.indexOf(at(minute, second));
      expect(model.v[i], `flagged sample at ${minute}:${second}`).toBe(value);
      expect(flaggedAt.has(at(minute, second))).toBe(true);
    }
    for (const [minute, second, value] of PLAN.unflaggedImplausible) {
      const i = model.t.indexOf(at(minute, second));
      expect(model.v[i], `unflagged oddity at ${minute}:${second}`).toBe(value);
      expect(model.flagged.includes(i), "an implausible value nobody flagged is NOT marked").toBe(false);
    }
    expect(model.flagged).toHaveLength(PLAN.flagged.length);

    // HRV (sparse): 48 half-hourly samples, no gap at that cadence
    const hrv = contract.quantityMetrics.find((m) => m.id === "hrvSdnn")!;
    const hrvModel = await loadDay(fhir, patient.id, hrv, contract, PLAN.day, { now: new Date("2030-01-01T00:00:00Z") });
    expect(hrvModel.n).toBe(48);
    expect(hrvModel.gaps).toHaveLength(0);
  }, 300_000);
});


describe.skipIf(!live)("sleep against the live stack (the known nights, and every night the API has)", () => {
  type Expected = {
    sessionStartMs: number; night: string; isMain: boolean; asleepMin: number; coreMin: number; deepMin: number; remMin: number;
    unspecifiedMin: number; awakeMin: number; unscoredMin: number; overlapMin: number; awakenings: number; latencyMin: number;
    wakeAfterEndMin: number; intervalCount: number;
  };
  type Night = { id: string; night: string; label: string; intervals: unknown[] };
  const FIELDS = [
    "asleepMin", "coreMin", "deepMin", "remMin", "unspecifiedMin", "awakeMin", "unscoredMin", "overlapMin", "awakenings",
    "latencyMin", "wakeAfterEndMin", "intervalCount",
  ] as const;

  it("the API, the web's own timeline and an independent per-minute reading agree on every seeded night", async () => {
    process.env["POC_CAPTURE_USER_PASSWORD"] ??= "unused-here";
    const fixtures = (await import(new URL("../tools/seed-sleep-nights.mjs", import.meta.url).href)) as {
      NIGHTS: Night[]; expectedSessions: (i: unknown[]) => Expected[];
    };
    const token = await clinicianToken();
    const fhir = new FhirClient(fhirBase, async () => token);
    const patient = await loadPatient(fhir, { ...config, patientIdentifier: process.env["POC_PATIENT_IDENTIFIER"] ?? "poc-0001" }, contract);
    const api = new AnalyticsClient("https://macpro16.local", async () => token, apiFetch);

    for (const n of fixtures.NIGHTS) {
      // the worker scans every 30 s: wait for it to have caught up before comparing
      let response = await api.sleep(patient.id, n.night, n.night);
      for (let i = 0; i < 12 && (response.sessions.length === 0 || response.completeness.pendingWindows > 0); i++) {
        await new Promise((r) => setTimeout(r, 5000));
        response = await api.sleep(patient.id, n.night, n.night);
      }
      const want = fixtures.expectedSessions(n.intervals);
      expect(response.sessions, `${n.id}: sessions on ${n.night} (run \`make web-seed-sleep-nights\`)`).toHaveLength(want.length);

      for (const e of want) {
        const session = response.sessions.find((s) => Date.parse(s.start) === e.sessionStartMs);
        expect(session, `${n.id}: the session starting ${new Date(e.sessionStartMs).toISOString()}`).toBeDefined();
        // 1. the analytic API against the independent reading
        for (const f of FIELDS) expect(session![f], `${n.id} ${f} (API vs expected)`).toBeCloseTo(e[f], 6);
        expect(session!.isMain, `${n.id} isMain`).toBe(e.isMain);
        expect(session!.night).toBe(e.night);

        // 2. the web's resolved timeline against the API (and so against the reading)
        const model = await loadNight(fhir, patient.id, contract, session!);
        expect(model.stats, `${n.id}: a timeline was built`).not.toBeNull();
        expect(disagreement(model.stats!, session!), `${n.id}: hypnogram vs API`).toBeNull();
        expect(model.intervals).toHaveLength(e.intervalCount);
      }
    }
  }, 300_000);

  it("the clock change is noticed on the DST night and only there", async () => {
    process.env["POC_CAPTURE_USER_PASSWORD"] ??= "unused-here";
    const { NIGHTS } = (await import(new URL("../tools/seed-sleep-nights.mjs", import.meta.url).href)) as { NIGHTS: Night[] };
    const token = await clinicianToken();
    const fhir = new FhirClient(fhirBase, async () => token);
    const patient = await loadPatient(fhir, { ...config, patientIdentifier: process.env["POC_PATIENT_IDENTIFIER"] ?? "poc-0001" }, contract);
    const api = new AnalyticsClient("https://macpro16.local", async () => token, apiFetch);
    const noteFor = async (night: string) => {
      const s = (await api.sleep(patient.id, night, night)).sessions.find((x) => x.isMain)!;
      const model = await loadNight(fhir, patient.id, contract, s);
      return { model, offsets: offsetsIn([...model.intervals]), text: nightSummary(model.stats!, [...model.intervals], true), s };
    };
    const dst = await noteFor(NIGHTS.find((n) => n.id === "dst")!.night);
    expect(dst.offsets).toEqual(["-08:00", "-07:00"]);
    expect(dst.text).toMatch(/offset changed during this night \(UTC-08:00 then UTC-07:00\)/);
    const note = clockNote([...dst.model.intervals], dst.model.stats!.startMs, dst.model.stats!.endMs);
    expect(Math.round(note.clockMinusElapsedMin)).toBe(60); // the clock reads an hour more than elapsed

    const plain = await noteFor(NIGHTS.find((n) => n.id === "known")!.night);
    expect(plain.offsets).toEqual(["-07:00"]);
    expect(plain.text).not.toMatch(/offset changed/);
  }, 120_000);

  it("every night the API has matches the intervals in HAPI (the summary equals what the stage Observations say)", async () => {
    const token = await clinicianToken();
    const fhir = new FhirClient(fhirBase, async () => token);
    const patient = await loadPatient(fhir, { ...config, patientIdentifier: process.env["POC_PATIENT_IDENTIFIER"] ?? "poc-0001" }, contract);
    const api = new AnalyticsClient("https://macpro16.local", async () => token, apiFetch);
    const to = todayUtc(new Date());
    const all = await api.sleep(patient.id, addDays(to, -365), to);
    expect(all.sessions.length, "the stack holds sleep data").toBeGreaterThan(5);
    let checked = 0;
    for (const s of all.sessions) {
      const model = await loadNight(fhir, patient.id, contract, s);
      const bad = model.stats ? disagreement(model.stats, s) : { field: "no timeline", web: 0, api: 0 };
      expect(bad, `night ${s.night} session ${s.start}`).toBeNull();
      checked++;
    }
    console.log(`sleep: ${checked} sessions cross-checked, intervals vs summary`);
  }, 300_000);
});


describe.skipIf(!live)("nutrition against the live stack (the seeded days, `make web-seed-nutrition-days`)", () => {
  type Seed = {
    FIRST_DAY: string; DAYS: number; FIXTURE_DAYS: { day: string; i: number; entries: { key: string; nutrient: string; retract?: boolean }[] }[];
    expectedTotals: () => Map<string, { micro: bigint; entries: number; byMeal: Map<string, bigint>; flagged: number }>;
    microToNumber: (m: bigint) => number;
  };

  /** Every nutrition Observation of the patient in the window, read straight from HAPI: final only, by the date written in each timestamp. */
  async function independentTotals(token: string, patientId: string, from: string, to: string) {
    const raw = rawContract as { metrics: { id: string; kind: string; loinc?: { code: string }; customCode?: { code: string } }[] };
    const idOfCode = new Map(raw.metrics.filter((m) => m.kind === "intake").map((m) => [(m.customCode ?? m.loinc)!.code, m.id]));
    const domain = (rawContract as unknown as { systems: { observationDomain: string } }).systems.observationDomain;
    const totals = new Map<string, bigint>();
    const retracted: string[] = [];
    const q = new URLSearchParams({ subject: `Patient/${patientId}`, category: `${domain}|nutrition`, _count: "100", date: `ge${addDays(from, -1)}T00:00:00Z` });
    q.append("date", `lt${addDays(to, 2)}T00:00:00Z`);
    let url: string | null = `${fhirBase}/Observation?${q.toString()}`;
    while (url) {
      const bundle = (await (await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/fhir+json", "Cache-Control": "no-cache" } })).json()) as {
        entry?: { resource: Observation & { identifier?: { value: string }[] } }[]; link?: { relation: string; url: string }[];
      };
      for (const { resource: r } of bundle.entry ?? []) {
        if (r.status !== "final") { retracted.push(r.identifier?.[0]?.value ?? ""); continue; }
        const id = idOfCode.get(r.code?.coding?.[0]?.code ?? "")!;
        const [whole = "0", frac = ""] = String(r.valueQuantity!.value).split(".");
        const micro = BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
        const key = `${id}|${(r.effectiveDateTime ?? "").slice(0, 10)}`;
        totals.set(key, (totals.get(key) ?? 0n) + micro);
      }
      url = bundle.link?.find((l) => l.relation === "next")?.url ?? null;
    }
    return { totals, retracted };
  }

  it("the API's daily totals equal the seeded expectations and an independent sum of the FHIR Observations; the view's cells agree, gaps and the zero day included, and the retracted dessert is out", async () => {
    process.env["POC_CAPTURE_USER_PASSWORD"] ??= "unused-here";
    const seed = (await import(new URL("../tools/seed-nutrition-days.mjs", import.meta.url).href)) as Seed;
    const token = await clinicianToken();
    const fhir = new FhirClient(fhirBase, async () => token);
    const patient = await loadPatient(fhir, { ...config, patientIdentifier: process.env["POC_PATIENT_IDENTIFIER"] ?? "poc-0001" }, contract);
    const api = new AnalyticsClient("https://macpro16.local", async () => token, apiFetch);
    const from = seed.FIRST_DAY;
    const to = addDays(from, seed.DAYS - 1);
    const expected = seed.expectedTotals();
    const energyDays = new Set([...expected.keys()].filter((k) => k.startsWith("dietaryEnergy|")).map((k) => k.slice("dietaryEnergy|".length)));
    expect(energyDays.size, "control: the fixture has days with energy").toBeGreaterThan(10);
    expect(energyDays.size).toBeLessThan(seed.DAYS); // and gaps

    // the worker scans every 30 s: wait for it to have caught up with the seed
    let energy = await api.nutrition(patient.id, "dietaryEnergy", from, to);
    for (let i = 0; i < 24 && (energy.completeness.pendingWindows > 0 || energy.days.length !== energyDays.size); i++) {
      await new Promise((r) => setTimeout(r, 5000));
      energy = await api.nutrition(patient.id, "dietaryEnergy", from, to);
    }
    expect(energy.days.length, "the stack holds the seeded days (run `make web-seed-nutrition-days`)").toBe(energyDays.size);

    const independent = await independentTotals(token, patient.id, from, to);
    expect(independent.retracted.some((id) => id.endsWith("dessert-e")), "control: the dessert really is retracted in HAPI").toBe(true);

    let compared = 0;
    for (const m of contract.intakeMetrics) {
      const res = m.id === "dietaryEnergy" ? energy : await api.nutrition(patient.id, m.id, from, to);
      expect(res.completeness.pendingWindows, m.id).toBe(0);
      const cells = buildCells(res);
      expect(cells).toHaveLength(seed.DAYS);
      for (const d of seed.FIXTURE_DAYS) {
        const exp = expected.get(`${m.id}|${d.day}`);
        const cell = cells.find((c) => c.day === d.day)!;
        if (!exp) {
          expect(cell.kind, `${m.id} ${d.day}: nothing was recorded, so a gap and not a 0`).toBe("none");
          expect(independent.totals.has(`${m.id}|${d.day}`), `${m.id} ${d.day}`).toBe(false);
          continue;
        }
        expect(cell.kind, `${m.id} ${d.day}`).toBe("entries");
        if (cell.kind !== "entries") continue;
        expect(cell.total, `${m.id} ${d.day} total vs the seed's own sum`).toBeCloseTo(seed.microToNumber(exp.micro), 6);
        expect(cell.entries, `${m.id} ${d.day} entries`).toBe(exp.entries);
        expect(cell.artifactSuspected, `${m.id} ${d.day} flags`).toBe(exp.flagged);
        expect(new Set(cell.byMeal.map((x) => x.meal)), `${m.id} ${d.day} meals`).toEqual(new Set(exp.byMeal.keys()));
        for (const part of cell.byMeal) expect(part.total).toBeCloseTo(seed.microToNumber(exp.byMeal.get(part.meal)!), 6);
        const fromHapi = independent.totals.get(`${m.id}|${d.day}`)!;
        expect(Math.abs(cell.total - seed.microToNumber(fromHapi)), `${m.id} ${d.day} total vs HAPI`).toBeLessThan(1e-6);
        compared++;
      }
      // the extra days the API reports are exactly the seeded ones
      expect(withEntries(cells).length).toBe([...expected.keys()].filter((k) => k.startsWith(`${m.id}|`)).length);
    }
    expect(compared).toBeGreaterThan(100);

    // the named days, by name: a zero total is a day with entries; the evening entry stays on its recorded day; no meal is a bucket
    const day = (i: number) => energy.days.find((d) => d.day === seed.FIXTURE_DAYS[i]!.day);
    expect(day(9)?.total, "the zero day is present, as 0").toBe(0);
    expect(day(9)?.entries).toBe(2);
    expect(day(5), "a gap day is not in the list").toBeUndefined();
    expect(energy.completeness.missingDays).toEqual(expect.arrayContaining([seed.FIXTURE_DAYS[5]!.day, seed.FIXTURE_DAYS[6]!.day, seed.FIXTURE_DAYS[13]!.day]));
    expect(day(11)!.byMeal.some((x) => x.meal === "snack" && x.total >= 220), "23:40 UTC-7 is the 2nd, not the 3rd (UTC)").toBe(true);
    expect(energy.days.find((d) => d.day === addDays(seed.FIXTURE_DAYS[11]!.day, 1))!.byMeal.reduce((n, x) => n + x.total, 0)).toBeLessThan(2000);
    expect(day(15)!.byMeal.map((x) => x.meal)).toContain("unlabelled");
    expect(day(17)!.total, "the retracted 999 kcal dessert is not in the day").toBeLessThan(2000);
    expect(day(19)!.total, "the flagged absurd entry is in the total, and counted as suspect").toBeGreaterThan(7200);
    expect(day(19)!.artifactSuspected).toBe(1);
    expect(mealKeys(buildCells(energy), contract.mealTypes.map((m) => m.code))).toEqual(["breakfast", "lunch", "dinner", "snack", "unlabelled"]);
    console.log(`nutrition: ${compared} (nutrient, day) totals agree with the seed and with HAPI`);
  }, 300_000);
});
