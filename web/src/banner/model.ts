import type { WebContract } from "../contract.ts";
import type { Observation, Patient } from "../fhir/types.ts";

export type SourceKind = "synthetic" | "healthKit" | "unknown";

export interface LatestValue {
  readonly metricId: string;
  readonly display: string;
  readonly unit: string;
  readonly value: number;
  /** When the sample was taken (its own instant). */
  readonly effective: string;
  /** When the server received it (`meta.lastUpdated`), or `null` if the server did not say. */
  readonly receivedAt: string | null;
  readonly source: SourceKind;
}

export type Staleness =
  | { readonly state: "none" } // nothing has ever been received
  | { readonly state: "current"; readonly ageMinutes: number; readonly thresholdMinutes: number }
  | { readonly state: "stale"; readonly ageMinutes: number; readonly thresholdMinutes: number };

export interface BannerModel {
  readonly patientName: string;
  readonly patientIdentifier: string | null;
  readonly values: readonly LatestValue[];
  /** Metrics with no value yet (shown as "no data", never as zero or blank). */
  readonly missing: readonly { readonly metricId: string; readonly display: string }[];
  readonly lastReceivedAt: string | null;
  readonly staleness: Staleness;
  readonly sources: readonly SourceKind[];
  /** The newest timestamp was ahead of the clock (clock skew); the age is shown as 0. */
  readonly timestampInFuture: boolean;
}

const instant = (o: Observation): string | undefined => o.effectiveDateTime ?? o.effectivePeriod?.end ?? o.effectivePeriod?.start;
const ms = (iso: string | undefined): number => (iso === undefined ? Number.NaN : Date.parse(iso));

export function sourceKind(meta: Observation["meta"], contract: WebContract): SourceKind {
  if (meta?.source === contract.metaSource.synthetic) {
    return "synthetic";
  }
  if (meta?.source === contract.metaSource.healthKit) {
    return "healthKit";
  }
  return "unknown";
}

function patientName(patient: Patient): string {
  const name = patient.name?.[0];
  if (!name) {
    return "Unnamed patient";
  }
  if (name.text) {
    return name.text;
  }
  return [...(name.given ?? []), name.family].filter((p): p is string => !!p).join(" ") || "Unnamed patient";
}

/**
 * The banner's facts from a patient and the latest Observation per code (`Observation/$lastn`, max=1):
 *  - latest value per quantity metric (by the sample's own time; ties by when the server received it),
 *  - "last data received": the newest `meta.lastUpdated` over everything returned, sleep stages included,
 *  - staleness: that age against the threshold (equal to the threshold is still current),
 *  - source kinds, with anything the contract does not name shown as `unknown`, not dropped.
 */
export function buildBanner(
  patient: Patient,
  observations: readonly Observation[],
  contract: WebContract,
  now: Date,
  thresholdMinutes: number,
): BannerModel {
  const values: LatestValue[] = [];
  const missing: { metricId: string; display: string }[] = [];
  for (const metric of contract.quantityMetrics) {
    const candidates = observations.filter(
      (o) => o.code?.coding?.some((c) => c.system === contract.loincSystem && c.code === metric.loincCode) &&
        typeof o.valueQuantity?.value === "number" && Number.isFinite(ms(instant(o))),
    );
    candidates.sort((a, b) => ms(instant(b)) - ms(instant(a)) || ms(b.meta?.lastUpdated) - ms(a.meta?.lastUpdated));
    const latest = candidates[0];
    if (!latest || latest.valueQuantity?.value === undefined) {
      missing.push({ metricId: metric.id, display: metric.display });
      continue;
    }
    values.push({
      metricId: metric.id,
      display: metric.display,
      unit: metric.unit,
      value: latest.valueQuantity.value,
      effective: instant(latest) as string,
      receivedAt: latest.meta?.lastUpdated ?? null,
      source: sourceKind(latest.meta, contract),
    });
  }

  const received = observations
    .map((o) => ms(o.meta?.lastUpdated))
    .filter((t) => Number.isFinite(t));
  const newest = received.length > 0 ? Math.max(...received) : null;
  let staleness: Staleness = { state: "none" };
  let timestampInFuture = false;
  if (newest !== null) {
    const raw = (now.getTime() - newest) / 60_000;
    timestampInFuture = raw < 0;
    const ageMinutes = Math.max(0, raw);
    staleness = ageMinutes > thresholdMinutes
      ? { state: "stale", ageMinutes, thresholdMinutes }
      : { state: "current", ageMinutes, thresholdMinutes };
  }

  const kinds = new Set<SourceKind>(observations.map((o) => sourceKind(o.meta, contract)));
  const sources = (["synthetic", "healthKit", "unknown"] as const).filter((k) => kinds.has(k));
  return {
    patientName: patientName(patient),
    patientIdentifier: patient.identifier?.find((i) => i.system === contract.patientIdentifierSystem)?.value ?? null,
    values,
    missing,
    lastReceivedAt: newest === null ? null : new Date(newest).toISOString(),
    staleness,
    sources,
    timestampInFuture,
  };
}
