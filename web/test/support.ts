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

export const bundle = (resources: unknown[]) => ({
  resourceType: "Bundle",
  type: "searchset",
  entry: resources.map((resource) => ({ resource })),
});

export const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/fhir+json" } });

/**
 * A stand-in for HAPI's search that honors what the banner sends: patient lookup by identifier, a per-code search
 * sorted by `-date`, and an any-code search sorted by `-_lastUpdated` (both `_count=1`). Records every URL.
 */
export function fakeHapi(
  observations: Observation[],
  opts: { patients?: unknown[]; status?: number; failNetwork?: () => boolean } = {},
) {
  const urls: string[] = [];
  const impl = async (input: string | URL | Request): Promise<Response> => {
    const url = decodeURIComponent(String(input));
    urls.push(url);
    if (opts.failNetwork?.()) throw new TypeError("Failed to fetch");
    if (opts.status && opts.status !== 200) return json(opts.status, {});
    if (url.includes("Patient?")) return json(200, bundle(opts.patients ?? [patient]));
    const ms = (v: string | undefined) => (v === undefined ? Number.NaN : Date.parse(v));
    const eff = (o: Observation) => ms(o.effectiveDateTime ?? o.effectivePeriod?.end);
    if (url.includes("_sort=-_lastUpdated")) {
      const sorted = [...observations].sort((a, b) => ms(b.meta?.lastUpdated) - ms(a.meta?.lastUpdated));
      return json(200, bundle(sorted.slice(0, 1).map((o) => ({ resourceType: "Observation", meta: o.meta }))));
    }
    const wanted = /code=([^&]*)/.exec(url)?.[1];
    const matches = observations.filter((o) => o.code?.coding?.some((c) => `${c.system}|${c.code}` === wanted));
    matches.sort((a, b) => eff(b) - eff(a));
    return json(200, bundle(matches.slice(0, 1)));
  };
  return Object.assign(vi.fn(impl), { urls });
}
