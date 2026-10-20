import type { Contract, IntakeMetric, QuantityMetric } from "./contract.ts";
import { dayAsRecorded, nextDay, searchSpanFor, utcDay } from "./day.ts";
import { mealOf, totalsFor, type IntakeEntry } from "./intake.ts";
import { affectedNights, buildSessions, fetchRange, type StageInterval } from "./sleep.ts";
import type { FhirSearch, ObservationLite } from "./fhir.ts";
import { summarize } from "./rollup.ts";
import type { Store, Window } from "./store.ts";
import { windowKey } from "./store.ts";

export interface WorkerOptions {
  readonly name: string;
  readonly contract: Contract;
  readonly fhir: FhirSearch;
  readonly store: Store;
  /**
   * Re-read this far behind the watermark. HAPI stamps `lastUpdated` when a transaction starts, so one that commits
   * later can carry a time slightly BEFORE one already seen; the overlap makes sure it is still found. Re-reading is
   * harmless because every step is idempotent.
   */
  readonly overlapMs?: number;
  readonly pageSize?: number;
}

export interface CycleReport {
  /** Observations returned by the change scan. */
  scanned: number;
  /** Scanned observations ignored (no usable subject, code or time). */
  ignored: number;
  /** Distinct windows the scan touched. */
  touched: number;
  /** Windows recomputed (includes ones pending from an earlier, interrupted cycle). */
  recomputed: number;
  /** Recomputed windows whose stored rollup actually changed. */
  changed: number;
  /** Observations skipped while recomputing because their unit was not the contract's. */
  wrongUnit: number;
  /** Dietary entries skipped while recomputing because the amount was negative or not a number. */
  invalidValue: number;
  watermarkMs: number | null;
}

const DEFAULT_OVERLAP_MS = 60_000;
const DEFAULT_PAGE = 200;

/** `Patient/123` -> `123`; anything else is not a patient reference the worker understands. */
export function patientIdOf(reference: string | undefined): string | null {
  const match = /^(?:.*\/)?Patient\/([A-Za-z0-9\-.]{1,64})$/.exec(reference ?? "");
  return match?.[1] ?? null;
}

/** The instant a rollup day is taken from: the instant itself, or the start of a period. */
export function effectiveInstant(o: ObservationLite): string | undefined {
  return o.effectiveDateTime ?? o.effectivePeriod?.start;
}

/** A period with both ends and end after start, as epoch ms; sleep stages are always intervals. */
export function periodMs(o: ObservationLite): { startMs: number; endMs: number } | null {
  const startMs = Date.parse(o.effectivePeriod?.start ?? "");
  const endMs = Date.parse(o.effectivePeriod?.end ?? "");
  return Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? { startMs, endMs } : null;
}

/** `subject=Patient/<id>`, escaped. */
function subjectParam(patientId: string): string {
  const reference = `Patient/${patientId}`;
  return `subject=${encodeURIComponent(reference)}`;
}

/** `code=<system>|<c1>,<system>|<c2>`, escaped (a comma-separated list is OR). */
function codeParam(system: string, codes: readonly string[]): string {
  return tokenParam(codes.map((c) => `${system}|${c}`));
}

/** `code=` for tokens that already carry their own system (intake codes come from two systems). */
function tokenParam(tokens: readonly string[]): string {
  return `code=${encodeURIComponent(tokens.join(","))}`;
}

const isoMs = (ms: number): string => new Date(ms).toISOString();

export class RollupWorker {
  private readonly overlapMs: number;
  private readonly pageSize: number;
  private readonly byCode: Map<string, QuantityMetric>;
  private readonly intakeByToken: Map<string, IntakeMetric>;

  constructor(private readonly o: WorkerOptions) {
    this.overlapMs = o.overlapMs ?? DEFAULT_OVERLAP_MS;
    this.pageSize = o.pageSize ?? DEFAULT_PAGE;
    this.byCode = new Map(o.contract.quantityMetrics.map((m) => [m.loincCode, m]));
    this.intakeByToken = new Map(o.contract.intakeMetrics.map((m) => [`${m.codeSystem}|${m.code}`, m]));
  }

  /** One full cycle: find what changed, then bring every touched window up to date. */
  async runOnce(): Promise<CycleReport> {
    const report: CycleReport = {
      scanned: 0, ignored: 0, touched: 0, recomputed: 0, changed: 0, wrongUnit: 0, invalidValue: 0, watermarkMs: null,
    };
    await this.scan(report);
    await this.recomputePending(report);
    report.watermarkMs = await this.o.store.getWatermark(this.o.name);
    return report;
  }

  // 1. what changed since last time -> touched windows + watermark, in one transaction
  private async scan(report: CycleReport): Promise<void> {
    const { contract, fhir, store, name } = this.o;
    const watermark = await store.getWatermark(name);
    const since = Math.max(0, (watermark ?? 0) - this.overlapMs);
    const tokens = [
      ...contract.quantityMetrics.map((m) => `${contract.loincSystem}|${m.loincCode}`),
      ...(contract.sleep ? [...contract.sleep.stageByCode.keys()].map((c) => `${contract.loincSystem}|${c}`) : []),
      ...this.intakeByToken.keys(),
    ];
    const path =
      `Observation?_lastUpdated=ge${encodeURIComponent(isoMs(since))}` +
      `&${tokenParam(tokens)}&_sort=_lastUpdated&_count=${this.pageSize}` +
      `&_elements=meta,subject,code,effectiveDateTime,effectivePeriod`;

    const touched = new Map<string, Window>();
    let newest: number | null = null;
    for await (const obs of fhir.search(path)) {
      report.scanned++;
      const windows = this.windowsOf(obs);
      const updated = Date.parse(obs.meta?.lastUpdated ?? "");
      if (Number.isFinite(updated) && (newest === null || updated > newest)) {
        newest = updated;
      }
      if (windows.length === 0) {
        report.ignored++;
        continue;
      }
      for (const window of windows) {
        touched.set(windowKey(window), window);
      }
    }
    report.touched = touched.size;
    await store.recordTouched(name, [...touched.values()], newest);
  }

  /** The windows one Observation affects: one day for a quantity, several nights for a sleep stage. */
  private windowsOf(obs: ObservationLite): Window[] {
    const patientId = patientIdOf(obs.subject?.reference);
    if (!patientId) {
      return [];
    }
    const sleepStage = this.sleepStageOf(obs);
    if (sleepStage) {
      const span = periodMs(obs);
      if (!span) {
        return [];
      }
      return affectedNights(span.startMs, span.endMs).map((day) => ({
        patientId, metricId: this.o.contract.sleep!.id, day,
      }));
    }
    const intake = this.intakeOf(obs);
    if (intake) {
      // dietary intake belongs to the day as recorded, not the UTC day (D3)
      const recorded = effectiveInstant(obs);
      const recordedDay = recorded ? dayAsRecorded(recorded) : null;
      return recordedDay ? [{ patientId, metricId: intake.id, day: recordedDay }] : [];
    }
    const instant = effectiveInstant(obs);
    const day = instant ? utcDay(instant) : null;
    const loinc = obs.code?.coding?.find((c) => c.system === this.o.contract.loincSystem && c.code && this.byCode.has(c.code));
    const metric = loinc?.code ? this.byCode.get(loinc.code) : undefined;
    return day && metric ? [{ patientId, metricId: metric.id, day }] : [];
  }

  private intakeOf(obs: ObservationLite): IntakeMetric | null {
    for (const c of obs.code?.coding ?? []) {
      const metric = c.system && c.code ? this.intakeByToken.get(`${c.system}|${c.code}`) : undefined;
      if (metric) {
        return metric;
      }
    }
    return null;
  }

  private sleepStageOf(obs: ObservationLite): string | null {
    const sleep = this.o.contract.sleep;
    if (!sleep) {
      return null;
    }
    for (const c of obs.code?.coding ?? []) {
      const stage = c.system === this.o.contract.loincSystem && c.code ? sleep.stageByCode.get(c.code) : undefined;
      if (stage) {
        return stage;
      }
    }
    return null;
  }

  // 2. recompute every pending window from the server's current data, idempotently
  private async recomputePending(report: CycleReport): Promise<void> {
    const { store } = this.o;
    for (;;) {
      const batch = await store.pendingWindows(100);
      if (batch.length === 0) {
        return;
      }
      for (const window of batch) {
        const changed = await this.recompute(window, report);
        report.recomputed++;
        if (changed) {
          report.changed++;
        }
      }
    }
  }

  private async recomputeNight(window: Window): Promise<boolean> {
    const { contract, fhir, store } = this.o;
    const sleep = contract.sleep!;
    const { fromMs, toMs } = fetchRange(window.day);
    const path =
      `Observation?${subjectParam(window.patientId)}` +
      `&${codeParam(contract.loincSystem, [...sleep.stageByCode.keys()])}` +
      `&date=ge${new Date(fromMs).toISOString()}&date=lt${new Date(toMs).toISOString()}` +
      `&_count=${this.pageSize}&_elements=status,subject,code,effectiveDateTime,effectivePeriod`;
    const seen = new Set<string>();
    const intervals: StageInterval[] = [];
    for await (const obs of fhir.search(path)) {
      if (seen.has(obs.id)) {
        continue;
      }
      seen.add(obs.id);
      if (obs.status !== "final") {
        continue; // retracted (entered-in-error) or anything else not final: not part of the night
      }
      const stage = this.sleepStageOf(obs);
      const span = periodMs(obs);
      if (!stage || !span || patientIdOf(obs.subject?.reference) !== window.patientId) {
        continue;
      }
      intervals.push({ id: obs.id, stage, startMs: span.startMs, endMs: span.endMs });
    }
    const sessions = buildSessions(window.patientId, intervals).filter((s) => s.night === window.day);
    return store.applyNights(window, sessions);
  }

  /**
   * One nutrient on one day as recorded: every final entry of the patient whose own date is the window's day, summed
   * (overall and by meal). The server's `date` search only narrows by instant, so the span is wider than the day and
   * every entry is checked against its own recorded date here.
   */
  private async recomputeIntake(window: Window, metric: IntakeMetric, report: CycleReport): Promise<boolean> {
    const { contract, fhir, store } = this.o;
    const span = searchSpanFor(window.day);
    const path =
      `Observation?${subjectParam(window.patientId)}` +
      `&${tokenParam([`${metric.codeSystem}|${metric.code}`])}` +
      `&date=ge${span.from}T00:00:00Z&date=lt${span.to}T00:00:00Z` +
      `&_count=${this.pageSize}&_elements=status,meta,subject,code,effectiveDateTime,effectivePeriod,valueQuantity,category`;
    const seen = new Set<string>();
    const entries: IntakeEntry[] = [];
    const { flags, meals } = contract;
    for await (const obs of fhir.search(path)) {
      if (seen.has(obs.id)) {
        continue;
      }
      seen.add(obs.id);
      if (obs.status !== "final") {
        continue; // retracted (entered-in-error) or anything else not final: not part of the day
      }
      const recorded = effectiveInstant(obs);
      if (!recorded || dayAsRecorded(recorded) !== window.day || patientIdOf(obs.subject?.reference) !== window.patientId ||
          this.intakeOf(obs)?.id !== metric.id) {
        continue;
      }
      const q = obs.valueQuantity;
      if (!q || typeof q.value !== "number" || !Number.isFinite(q.value)) {
        continue;
      }
      if (q.system !== contract.ucumSystem || q.code !== metric.ucum) {
        report.wrongUnit++;
        continue;
      }
      if (q.value < 0) {
        report.invalidValue++; // an intake is never negative (zero is a real amount); do not let one entry subtract
        continue;
      }
      const tags = (obs.meta?.tag ?? []).filter((t) => t.system === flags.system);
      entries.push({
        id: obs.id,
        value: q.value,
        instantMs: Date.parse(recorded),
        meal: meals ? mealOf(obs.category, meals) : null,
        artifactSuspected: tags.some((t) => t.code === flags.artifactSuspected),
        lateArrival: tags.some((t) => t.code === flags.lateArrival),
      });
    }
    return store.applyIntake(window, totalsFor(window, metric.ucum, entries));
  }

  private async recompute(window: Window, report: CycleReport): Promise<boolean> {
    const { contract, fhir, store } = this.o;
    if (window.metricId === contract.sleep?.id) {
      return this.recomputeNight(window);
    }
    const intakeMetric = contract.intakeMetrics.find((m) => m.id === window.metricId);
    if (intakeMetric) {
      return this.recomputeIntake(window, intakeMetric, report);
    }
    const metric = contract.quantityMetrics.find((m) => m.id === window.metricId);
    if (!metric) {
      // The contract no longer has this metric: nothing to compute, and the stale mark must not loop forever.
      return store.applyRollup(window, null);
    }
    const path =
      `Observation?${subjectParam(window.patientId)}` +
      `&${codeParam(contract.loincSystem, [metric.loincCode])}` +
      `&date=ge${window.day}T00:00:00Z&date=lt${nextDay(window.day)}T00:00:00Z` +
      `&_count=${this.pageSize}&_elements=status,meta,subject,code,effectiveDateTime,effectivePeriod,valueQuantity`;

    // Local re-checks matter: the server's `date` search on a period matches any overlap, and the unit and the day
    // are ours to enforce, not HAPI's.
    const seen = new Set<string>();
    const values: number[] = [];
    let nArtifact = 0;
    let nLate = 0;
    const { flags } = contract;
    for await (const obs of fhir.search(path)) {
      if (seen.has(obs.id)) {
        continue;
      }
      seen.add(obs.id);
      if (obs.status !== "final") {
        continue; // retracted (entered-in-error) or anything else not final: not part of the day
      }
      const instant = effectiveInstant(obs);
      if (!instant || utcDay(instant) !== window.day || patientIdOf(obs.subject?.reference) !== window.patientId) {
        continue;
      }
      const q = obs.valueQuantity;
      if (!q || typeof q.value !== "number" || !Number.isFinite(q.value)) {
        continue;
      }
      if (q.system !== contract.ucumSystem || q.code !== metric.ucum) {
        report.wrongUnit++;
        continue;
      }
      values.push(q.value);
      // Flags are only ever READ from the stored tag (never inferred from the value): the system and codes are the contract's.
      for (const tag of obs.meta?.tag ?? []) {
        if (tag.system !== flags.system) {
          continue;
        }
        if (tag.code === flags.artifactSuspected) {
          nArtifact++;
        } else if (tag.code === flags.lateArrival) {
          nLate++;
        }
      }
    }
    const summary = summarize(values);
    return store.applyRollup(
      window,
      summary && {
        ...window, unit: metric.ucum, n: summary.n, min: summary.min, median: summary.median, max: summary.max,
        nArtifact, nLate,
      },
    );
  }
}
