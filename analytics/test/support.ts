import type { Contract } from "../src/contract.ts";
import { loadContract } from "../src/contract.ts";
import type { FhirSearch, HistoryEntry, ObservationLite } from "../src/fhir.ts";

export const contract: Contract = loadContract();
export const heartRate = contract.quantityMetrics.find((m) => m.id === "heartRate")!;
export const hrv = contract.quantityMetrics.find((m) => m.id === "hrvSdnn")!;
/** Heart-rate variability as Health Connect measures it: coded in the contract's own system, not LOINC (contract 1.6.0). */
export const rmssd = contract.quantityMetrics.find((m) => m.id === "hrvRmssd")!;

/**
 * A stand-in for HAPI's Observation search that honors the parameters the worker sends (`_lastUpdated`, `code`,
 * `subject`, `date`) and stamps `meta.lastUpdated` from a clock the test controls. It records every request path so
 * tests can assert what was asked for.
 */
export class FakeFhir implements FhirSearch {
  readonly requests: string[] = [];
  private readonly resources: ObservationLite[] = [];
  /** What HAPI keeps of every change (a POST, a PUT, a soft DELETE), newest last, for `history`. */
  private readonly log: { method: string; url: string; lastModifiedMs: number }[] = [];
  private readonly versions = new Map<string, number>();
  /** The last live version of each deleted resource, readable by version (a soft delete keeps it in history). */
  private readonly graveyard = new Map<string, { version: number; resource: ObservationLite }>();
  /** Versions `read` answers 404 for, as a server that purged history would. */
  readonly purged = new Set<string>();
  /** Server time used to stamp `meta.lastUpdated` on `add`. */
  serverNow = Date.parse("2026-10-12T12:00:00.000Z");
  /** Simulates a server that does not honor the `code` search parameter (the worker must not trust it). */
  ignoreCodeFilter = false;

  add(o: Omit<ObservationLite, "meta">, lastUpdatedMs: number = this.serverNow, tag?: { system: string; code: string }[]): void {
    this.resources.push({ ...o, meta: { lastUpdated: new Date(lastUpdatedMs).toISOString(), ...(tag ? { tag } : {}) } });
    this.versions.set(o.id, 1);
    this.log.push({ method: "POST", url: `Observation/${o.id}/_history/1`, lastModifiedMs: lastUpdatedMs });
  }

  /** `add`, returning the new Observation's id (for a test that deletes or changes it later). */
  add2(o: Omit<ObservationLite, "meta">, lastUpdatedMs: number = this.serverNow, tag?: { system: string; code: string }[]): string {
    this.add(o, lastUpdatedMs, tag);
    return o.id;
  }

  /** A change to a stored Observation (a PUT in place): the new content, lastUpdated moves on. */
  update(id: string, change: Partial<ObservationLite>, atMs: number = this.serverNow): void {
    const r = this.resources.find((x) => x.id === id);
    if (!r) {
      throw new Error(`no such observation ${id}`);
    }
    Object.assign(r, change);
    r.meta = { ...r.meta, lastUpdated: new Date(atMs).toISOString() };
    const v = (this.versions.get(id) ?? 1) + 1;
    this.versions.set(id, v);
    this.log.push({ method: "PUT", url: `Observation/${id}/_history/${v}`, lastModifiedMs: atMs });
  }

  /** A soft delete, as HAPI does it: a search no longer finds it, the history says DELETE, the last live version stays readable. */
  remove(id: string, atMs: number = this.serverNow): void {
    const i = this.resources.findIndex((x) => x.id === id);
    if (i < 0) {
      throw new Error(`no such observation ${id}`);
    }
    const version = this.versions.get(id) ?? 1;
    this.graveyard.set(id, { version, resource: structuredClone(this.resources[i]!) });
    this.resources.splice(i, 1);
    this.versions.set(id, version + 1);
    this.log.push({ method: "DELETE", url: `Observation/${id}/_history/${version + 1}`, lastModifiedMs: atMs });
  }

  async *history(path: string): AsyncIterable<HistoryEntry> {
    this.requests.push(path);
    const since = Date.parse(new URL(path, "https://fake.invalid/fhir/").searchParams.get("_since") ?? "");
    // the server's own time when it answers: never earlier than its latest change (a DELETE has no time of its own)
    const asOfMs = Math.max(this.serverNow, ...this.log.map((e) => e.lastModifiedMs));
    for (const e of [...this.log].reverse()) {
      if (!Number.isFinite(since) || e.lastModifiedMs >= since) {
        yield { method: e.method, url: e.url, asOfMs };
      }
    }
  }

  async read(path: string): Promise<ObservationLite | null> {
    this.requests.push(path);
    const m = /^Observation\/([^/]+)\/_history\/(\d+)$/.exec(path);
    if (m && !this.purged.has(path)) {
      const dead = this.graveyard.get(m[1]!);
      if (dead && dead.version === Number(m[2])) {
        return structuredClone(dead.resource);
      }
    }
    return null;
  }

  /** What the capture app's retraction does to a stored Observation: status entered-in-error, lastUpdated moves on. */
  retract(id: string, atMs: number = this.serverNow): void {
    const r = this.resources.find((x) => x.id === id);
    if (!r) {
      throw new Error(`no such observation ${id}`);
    }
    r.status = "entered-in-error";
    r.meta = { ...r.meta, lastUpdated: new Date(atMs).toISOString() };
    const v = (this.versions.get(id) ?? 1) + 1;
    this.versions.set(id, v);
    this.log.push({ method: "PUT", url: `Observation/${id}/_history/${v}`, lastModifiedMs: atMs });
  }

  async *search(path: string): AsyncIterable<ObservationLite> {
    this.requests.push(path);
    const q = new URL(path, "https://fake.invalid/fhir/").searchParams;
    const codes = (q.get("code") ?? "").split(",").filter(Boolean);
    const since = q.get("_lastUpdated")?.startsWith("ge") ? Date.parse(q.get("_lastUpdated")!.slice(2)) : -Infinity;
    const subject = q.get("subject");
    const dates = q.getAll("date");
    const ge = dates.find((d) => d.startsWith("ge"))?.slice(2);
    const lt = dates.find((d) => d.startsWith("lt"))?.slice(2);
    const matches = this.resources
      .filter((r) => this.ignoreCodeFilter || codes.length === 0 || r.code?.coding?.some((c) => codes.includes(`${c.system}|${c.code}`)))
      .filter((r) => Date.parse(r.meta?.lastUpdated ?? "") >= since)
      .filter((r) => subject === null || r.subject?.reference === subject)
      .filter((r) => {
        const at = Date.parse(r.effectiveDateTime ?? r.effectivePeriod?.start ?? "");
        return (ge === undefined || at >= Date.parse(ge)) && (lt === undefined || at < Date.parse(lt));
      })
      .sort((a, b) => Date.parse(a.meta!.lastUpdated!) - Date.parse(b.meta!.lastUpdated!));
    for (const m of matches) {
      yield structuredClone(m);
    }
  }
}

let counter = 0;
export function quantity(
  patient: string, metric: { codeSystem: string; code: string; ucum: string }, value: number, at: string,
  overrides: Partial<ObservationLite> = {},
): Omit<ObservationLite, "meta"> {
  return {
    id: `obs-${++counter}`,
    status: "final",
    subject: { reference: `Patient/${patient}` },
    code: { coding: [{ system: metric.codeSystem, code: metric.code }] },
    effectiveDateTime: at,
    valueQuantity: { value, unit: metric.ucum, system: contract.ucumSystem, code: metric.ucum },
    ...overrides,
  };
}

/** A sleep stage Observation: a duration over `effectivePeriod`, coded per the contract. */
export function sleepStage(patient: string, stage: string, start: string, end: string): Omit<ObservationLite, "meta"> {
  const code = [...contract.sleep!.stageByCode].find(([, s]) => s === stage)?.[0];
  if (!code) {
    throw new Error(`contract has no stage ${stage}`);
  }
  return {
    id: `obs-${++counter}`,
    status: "final",
    subject: { reference: `Patient/${patient}` },
    code: { coding: [{ system: contract.loincSystem, code }] },
    effectivePeriod: { start, end },
    valueQuantity: {
      value: (Date.parse(end) - Date.parse(start)) / 60_000, system: contract.ucumSystem, code: "min",
    },
  };
}

export const energy = contract.intakeMetrics.find((m) => m.id === "dietaryEnergy")!;
export const protein = contract.intakeMetrics.find((m) => m.id === "dietaryProtein")!;
/** A nutrient coded in the contract's own system rather than LOINC. */
export const fiber = contract.intakeMetrics.find((m) => m.id === "dietaryFiber")!;

/**
 * A dietary intake Observation, shaped as the capture app writes it: the nutrient's code and unit from the contract
 * and, when a meal is given, a separate `category` entry in the contract's meal-type system.
 */
export function intake(
  patient: string, metric: { codeSystem: string; code: string; ucum: string }, value: number, at: string,
  opts: { meal?: string; overrides?: Partial<ObservationLite> } = {},
): Omit<ObservationLite, "meta"> {
  return {
    id: `obs-${++counter}`,
    status: "final",
    subject: { reference: `Patient/${patient}` },
    code: { coding: [{ system: metric.codeSystem, code: metric.code }] },
    ...(opts.meal ? { category: [{ coding: [{ system: contract.meals!.system, code: opts.meal }] }] } : {}),
    effectiveDateTime: at,
    valueQuantity: { value, unit: metric.ucum, system: contract.ucumSystem, code: metric.ucum },
    ...opts.overrides,
  };
}
