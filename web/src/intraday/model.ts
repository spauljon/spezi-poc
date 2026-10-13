/**
 * The intraday dense view's data model (M15): one UTC day of raw samples for one metric, and the pure rules that
 * turn them into what is drawn and what is said. No DOM, no canvas.
 *
 * Three things are decided here and nowhere else:
 *  - a GAP is an interval between consecutive samples longer than max(10 minutes, 10 x the day's median interval);
 *  - a sample is FLAGGED only when its Observation carries a stored data-quality flag (meta.tag, in the contract's
 *    flag system). Nothing is inferred from the value: an implausible value that nobody flagged is shown as it is;
 *  - a retracted (`entered-in-error`) Observation is not drawn, and the number excluded is stated.
 */
import type { QuantityMetric, WebContract } from "../contract.ts";
import type { Observation } from "../fhir/types.ts";

export const MIN_GAP_MS = 10 * 60_000;
export const GAP_FACTOR = 10;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

export interface Sample {
  readonly id: string;
  /** Measurement instant (Unix ms). A period is measured at its start (F2). */
  readonly t: number;
  readonly v: number;
  /** Stored data-quality flag codes on this Observation, in the contract's flag system. */
  readonly flags: readonly string[];
}

export type SkipReason = "noInstant" | "noValue" | "unitDiffers" | "retracted";

export interface Skipped {
  readonly noInstant: number;
  readonly noValue: number;
  readonly unitDiffers: number;
  readonly retracted: number;
}

export const noSkips = (): Skipped => ({ noInstant: 0, noValue: 0, unitDiffers: 0, retracted: 0 });

/** One Observation to a sample, or the reason it cannot be drawn. Never guesses a value, a unit or a time. */
export function toSample(o: Observation, metric: QuantityMetric, contract: WebContract): Sample | SkipReason {
  if (o.status === "entered-in-error") return "retracted";
  const at = o.effectiveDateTime ?? o.effectivePeriod?.start;
  const t = at === undefined ? Number.NaN : Date.parse(at);
  if (Number.isNaN(t)) return "noInstant";
  const q = o.valueQuantity;
  if (q?.value === undefined || !Number.isFinite(q.value)) return "noValue";
  // a different (or absent) unit would silently rescale the chart: leave it out and say so
  if ((q.code ?? q.unit) !== metric.unit) return "unitDiffers";
  const flags = (o.meta?.tag ?? [])
    .filter((c) => c.system === contract.dataQualityFlag.system && typeof c.code === "string")
    .map((c) => c.code as string);
  return { id: o.id ?? `${t}`, t, v: q.value, flags };
}

export interface Gap {
  readonly start: number;
  readonly end: number;
  /** Before the first sample or after the last one of the day, rather than between two samples. */
  readonly edge: "start" | "end" | null;
}

export interface HourRow {
  /** 0 to 23, UTC. */
  readonly hour: number;
  readonly n: number;
  readonly min: number | null;
  readonly median: number | null;
  readonly max: number | null;
  readonly flagged: number;
}

export interface DayModel {
  readonly day: string;
  readonly windowStart: number;
  /** The end of the day, or "now" when the day is still in progress (an unfinished day has no trailing gap). */
  readonly windowEnd: number;
  readonly t: readonly number[];
  readonly v: readonly number[];
  readonly flagged: readonly number[];
  readonly flagCodes: ReadonlyArray<readonly string[]>;
  readonly gaps: readonly Gap[];
  readonly gapThresholdMs: number;
  readonly medianIntervalMs: number | null;
  readonly hourly: readonly HourRow[];
  readonly n: number;
  readonly min: number | null;
  readonly median: number | null;
  readonly max: number | null;
  readonly skipped: Skipped;
}

export const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const nextDay = (day: string): string => new Date(dayStart(day) + DAY_MS).toISOString().slice(0, 10);
export const previousDay = (day: string): string => new Date(dayStart(day) - DAY_MS).toISOString().slice(0, 10);

export function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[m]! : (sorted[m - 1]! + sorted[m]!) / 2;
}

/**
 * Builds the model for one UTC day. `samples` may be unsorted and may hold ones outside the day or repeated (the same
 * Observation id twice is one sample): both are dropped here so a paging quirk cannot change the picture.
 */
export function buildDay(day: string, samples: readonly Sample[], skipped: Skipped = noSkips(), now: Date = new Date()): DayModel {
  const windowStart = dayStart(day);
  const windowEnd = Math.min(windowStart + DAY_MS, Math.max(now.getTime(), windowStart));
  const seen = new Set<string>();
  const inDay = samples
    .filter((s) => s.t >= windowStart && s.t < windowStart + DAY_MS)
    .filter((s) => (seen.has(s.id) ? false : (seen.add(s.id), true)))
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));

  const t = inDay.map((s) => s.t);
  const v = inDay.map((s) => s.v);
  const flagged: number[] = [];
  inDay.forEach((s, i) => { if (s.flags.length > 0) flagged.push(i); });

  const intervals: number[] = [];
  for (let i = 1; i < t.length; i++) {
    const d = t[i]! - t[i - 1]!;
    if (d > 0) intervals.push(d);
  }
  intervals.sort((a, b) => a - b);
  const medianIntervalMs = median(intervals);
  const gapThresholdMs = Math.max(MIN_GAP_MS, GAP_FACTOR * (medianIntervalMs ?? 0));

  const gaps: Gap[] = [];
  if (t.length > 0) {
    if (t[0]! - windowStart > gapThresholdMs) gaps.push({ start: windowStart, end: t[0]!, edge: "start" });
    for (let i = 1; i < t.length; i++) {
      if (t[i]! - t[i - 1]! > gapThresholdMs) gaps.push({ start: t[i - 1]!, end: t[i]!, edge: null });
    }
    if (windowEnd - t[t.length - 1]! > gapThresholdMs) gaps.push({ start: t[t.length - 1]!, end: windowEnd, edge: "end" });
  }

  const byHour: number[][] = Array.from({ length: 24 }, () => []);
  const flaggedByHour = new Array<number>(24).fill(0);
  t.forEach((ms, i) => {
    const h = Math.min(23, Math.floor((ms - windowStart) / HOUR_MS));
    byHour[h]!.push(v[i]!);
    if (inDay[i]!.flags.length > 0) flaggedByHour[h]!++;
  });
  const hourly: HourRow[] = byHour.map((vals, hour) => {
    const s = [...vals].sort((a, b) => a - b);
    return {
      hour, n: s.length, min: s[0] ?? null, median: median(s), max: s[s.length - 1] ?? null, flagged: flaggedByHour[hour]!,
    };
  });

  const sortedAll = [...v].sort((a, b) => a - b);
  return {
    day, windowStart, windowEnd, t, v, flagged, flagCodes: inDay.map((s) => s.flags), gaps, gapThresholdMs, medianIntervalMs,
    hourly, n: v.length, min: sortedAll[0] ?? null, median: median(sortedAll), max: sortedAll[sortedAll.length - 1] ?? null,
    skipped,
  };
}

// --- words ---

const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
export const minutes = (ms: number): number => Math.round(ms / 60_000);
export const durationText = (ms: number): string => {
  const m = minutes(ms);
  return m >= 120 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
};
const fmt = (v: number): string => String(Math.round(v * 10) / 10);
export const formatSample = fmt;
const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function gapText(g: Gap): string {
  const where = g.edge === "start" ? " (from the start of the day)" : g.edge === "end" ? " (to the end of the day so far)" : "";
  return `${hhmm(g.start)} to ${hhmm(g.end)} UTC, ${durationText(g.end - g.start)}${where}`;
}

/** Whether the extreme value is flagged: the summary never lets a clinician assume a spike was screened. */
function extremeText(model: DayModel, which: "lowest" | "highest", unit: string): string {
  const value = which === "lowest" ? model.min : model.max;
  if (value === null) return "";
  const at = model.v.indexOf(value);
  const flagged = model.flagged.includes(at);
  return `${which} ${fmt(value)} ${unit} at ${hhmm(model.t[at]!)} UTC (${flagged ? "flagged" : "not flagged"})`;
}

/** The sentence a screen reader gets for the chart, and everyone gets above it. */
export function summarize(model: DayModel, display: string, unit: string): string {
  if (model.n === 0) {
    const why = model.skipped.retracted > 0 ? ` ${count(model.skipped.retracted, "retracted Observation")} left out.` : "";
    return `${display}, ${model.day} (UTC): no samples.${why}`;
  }
  const parts = [
    `${display}, ${model.day} (UTC): ${count(model.n, "sample")} from ${hhmm(model.t[0]!)} to ${hhmm(model.t[model.n - 1]!)}, median ${fmt(model.median!)} ${unit}; ${extremeText(model, "lowest", unit)}; ${extremeText(model, "highest", unit)}.`,
  ];
  if (model.gaps.length === 0) {
    parts.push(`No gap of ${durationText(model.gapThresholdMs)} or more.`);
  } else {
    parts.push(`${count(model.gaps.length, "gap")} of ${durationText(model.gapThresholdMs)} or more: ${model.gaps.map(gapText).join("; ")}.`);
  }
  parts.push(
    model.flagged.length === 0
      ? "No sample carries a stored data-quality flag."
      : `${count(model.flagged.length, "sample")} carr${model.flagged.length === 1 ? "ies" : "y"} a stored data-quality flag.`,
  );
  const s = model.skipped;
  const left = [
    s.retracted > 0 ? `${count(s.retracted, "retracted Observation")}` : "",
    s.unitDiffers > 0 ? `${count(s.unitDiffers, "Observation")} with a different unit` : "",
    s.noValue > 0 ? `${count(s.noValue, "Observation")} with no value` : "",
    s.noInstant > 0 ? `${count(s.noInstant, "Observation")} with no time` : "",
  ].filter(Boolean);
  if (left.length > 0) parts.push(`Left out: ${left.join(", ")}.`);
  return parts.join(" ");
}
