import { vi } from "vitest";
import { parseContract, type WebContract } from "../src/contract.ts";
import type { WebConfig } from "../src/config.ts";
import type { Observation, Patient } from "../src/fhir/types.ts";
import rawContract from "../../contract/metrics.json";

export const contract: WebContract = parseContract(rawContract);
export const NOW = new Date("2026-10-12T12:00:00.000Z");

export const config: WebConfig = {
  issuer: "https://idp.test:8444/realms/poc",
  clientId: "clinician-web",
  fhirBase: "/fhir",
  analyticsBase: "/analytics",
  patientIdentifier: "poc-0001",
  staleAfterMinutes: 30,
  redirectUri: "https://web.test:3000/callback",
};

export const metric = (id: string) => {
  const m = contract.quantityMetrics.find((x) => x.id === id);
  if (!m) throw new Error(`no metric ${id}`);
  return m;
};

export const patient: Patient = {
  resourceType: "Patient",
  id: "42",
  identifier: [{ system: contract.patientIdentifierSystem, value: "poc-0001" }],
  name: [{ family: "Synthetic", given: ["Poc"] }],
};

/** A latest-value Observation as HAPI would return it. */
export function obs(
  metricId: string,
  value: number,
  effective: string,
  lastUpdated: string,
  source: "synthetic" | "healthKit" | string = "synthetic",
): Observation {
  const m = metric(metricId);
  const sourceUrl = source === "synthetic" ? contract.metaSource.synthetic
    : source === "healthKit" ? contract.metaSource.healthKit : source;
  return {
    resourceType: "Observation",
    id: `${metricId}-${effective}`,
    meta: { lastUpdated, source: sourceUrl },
    code: { coding: [{ system: contract.loincSystem, code: m.loincCode }] },
    effectiveDateTime: effective,
    valueQuantity: { value, unit: m.unit, system: "http://unitsofmeasure.org", code: m.unit },
  };
}

export function sleepObs(code: string, lastUpdated: string): Observation {
  return {
    resourceType: "Observation",
    meta: { lastUpdated, source: contract.metaSource.synthetic },
    code: { coding: [{ system: contract.loincSystem, code }] },
    effectivePeriod: { start: "2026-10-12T01:00:00+00:00", end: "2026-10-12T02:00:00+00:00" },
    valueQuantity: { value: 60 },
  };
}

/** One day of a metric as the analytic API serves it. */
export interface BandRow { day: string; n: number; min: number; median: number; max: number; revision?: number }

const DAYMS = 86_400_000;
const eachDay = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAYMS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

/**
 * A stand-in for the analytic API that evaluates what the app sends (`/analytics/v1/metrics` and
 * `/analytics/v1/patients/{id}/bands?metric&from&to`) and answers in the documented shape: only the days in range, a
 * completeness block that lists the missing days, and the contract's units.
 */
export function analyticsAnswer(
  url: string,
  data: Record<string, BandRow[]> = {},
  over: { pendingWindows?: number; metrics?: Array<{ id: string; display: string; unit: string }> } = {},
): Response {
  const u = new URL(url, "https://web.test");
  if (u.pathname.endsWith("/v1/metrics")) {
    return json(200, {
      contractVersion: contract.version,
      metrics: over.metrics ?? contract.quantityMetrics.map((m) => ({ id: m.id, display: m.display, unit: m.unit })),
    });
  }
  const m = /\/v1\/patients\/([^/]+)\/bands$/.exec(u.pathname);
  if (!m) return json(404, { error: "not_found", detail: "no such path" });
  const id = u.searchParams.get("metric") ?? "";
  const from = u.searchParams.get("from") ?? "";
  const to = u.searchParams.get("to") ?? "";
  const info = contract.quantityMetrics.find((x) => x.id === id);
  if (!info) return json(400, { error: "bad_request", detail: "unknown metric" });
  const days = eachDay(from, to);
  const rows = (data[id] ?? []).filter((r) => r.day >= from && r.day <= to);
  const have = new Set(rows.map((r) => r.day));
  return json(200, {
    patientId: m[1],
    metric: { id, display: info.display, unit: over.metrics?.find((x) => x.id === id)?.unit ?? info.unit },
    from,
    to,
    dayDefinition: "UTC calendar day of the sample's instant",
    bands: rows.map((r) => ({ revision: 1, ...r })),
    completeness: {
      requestedDays: days.length,
      daysWithData: rows.length,
      missingDays: days.filter((d) => !have.has(d)),
      pendingWindows: over.pendingWindows ?? 0,
      lastComputedAt: rows.length ? "2026-10-12T11:59:00.000Z" : null,
      workerWatermark: "2026-10-12T11:59:30.000Z",
      generatedAt: "2026-10-12T12:00:00.000Z",
    },
  });
}

export const bundle = (resources: unknown[]) => ({
  resourceType: "Bundle",
  type: "searchset",
  entry: resources.map((resource) => ({ resource })),
});

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/fhir+json" } });

/**
 * A stand-in for HAPI's Observation/Patient search that evaluates what the app sends: `patient`, `code` (comma list
 * of system|code), `status`, `_source`, `date` (ge/lt, on the effective instant or period start), `_sort` (with a
 * direction and `_id` as the final key), `_count`, `_offset`, `_total=accurate`, and `_elements=meta`. Records every
 * URL (decoded) so tests can assert on what was asked.
 */
export function fakeHapi(
  observations: Observation[],
  opts: {
    patients?: unknown[];
    status?: number;
    failNetwork?: () => boolean;
    /** Resolve a response later (to test that a stale answer is discarded). */
    delay?: (url: string) => Promise<void>;
    /** What the analytic API stand-in serves, per metric id (default: no days at all). */
    analytics?: Record<string, BandRow[]>;
    analyticsStatus?: number;
    analyticsOver?: Parameters<typeof analyticsAnswer>[2];
  } = {},
) {
  const urls: string[] = [];
  const ms = (v: string | undefined) => (v === undefined ? Number.NaN : Date.parse(v));
  const at = (o: Observation) => ms(o.effectiveDateTime ?? o.effectivePeriod?.start);
  const sortKey = (o: Observation, key: string): string | number => {
    switch (key) {
      case "date": return at(o);
      case "code": return o.code?.coding?.[0]?.code ?? "";
      case "value-quantity": return o.valueQuantity?.value ?? Number.NEGATIVE_INFINITY;
      case "status": return o.status ?? "";
      case "_lastUpdated": return ms(o.meta?.lastUpdated);
      default: return o.id ?? "";
    }
  };
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = decodeURIComponent(String(input));
    urls.push(url);
    if (opts.delay) await opts.delay(url);
    if (opts.failNetwork?.()) throw new TypeError("Failed to fetch");
    if (url.startsWith("/analytics/")) {
      if (opts.analyticsStatus && opts.analyticsStatus !== 200) return json(opts.analyticsStatus, { error: "x", detail: "x" });
      return analyticsAnswer(url, opts.analytics, opts.analyticsOver);
    }
    if (opts.status && opts.status !== 200) return json(opts.status, {});
    if (url.includes("Patient?")) return json(200, bundle(opts.patients ?? [patient]));

    const q = new URL(url, "https://hapi.test").searchParams;
    const codes = (q.get("code") ?? "").split(",").filter(Boolean);
    const ge = q.getAll("date").find((d) => d.startsWith("ge"))?.slice(2);
    const lt = q.getAll("date").find((d) => d.startsWith("lt"))?.slice(2);
    let rows = observations.filter((o) =>
      (codes.length === 0 || o.code?.coding?.some((c) => codes.includes(`${c.system}|${c.code}`))) &&
      (!q.get("status") || o.status === q.get("status")) &&
      (!q.get("_source") || o.meta?.source === q.get("_source")) &&
      (ge === undefined || at(o) >= ms(ge)) && (lt === undefined || at(o) < ms(lt)));
    const keys = (q.get("_sort") ?? "_id").split(",").map((k) => ({ key: k.replace(/^-/, ""), sign: k.startsWith("-") ? -1 : 1 }));
    rows = [...rows].sort((a, b) => {
      for (const { key, sign } of keys) {
        const x = sortKey(a, key), y = sortKey(b, key);
        if (x < y) return -1 * sign;
        if (x > y) return 1 * sign;
      }
      return 0;
    });
    const total = rows.length;
    const offset = Number(q.get("_offset") ?? 0);
    const count = Number(q.get("_count") ?? 50);
    let page: unknown[] = rows.slice(offset, offset + count);
    if (q.get("_elements") === "meta") {
      page = (page as Observation[]).map((o) => ({ resourceType: "Observation", meta: o.meta }));
    }
    return json(200, { ...bundle(page), ...(q.get("_total") === "accurate" ? { total } : {}) });
  };
  return Object.assign(vi.fn(impl), { urls });
}
