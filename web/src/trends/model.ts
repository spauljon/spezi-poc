/**
 * The longitudinal trend view's data model (M14): what the analytic API returns, and the pure transformations from
 * it to what a chart and its table twin show. No canvas, no DOM: every rule that matters (a day with no data is a gap,
 * never an interpolated value) is decided and tested here.
 */

export const DAY_MS = 86_400_000;
/** The analytic API refuses a longer span (`MAX_RANGE_DAYS` in analytics/src/api.ts). */
export const MAX_RANGE_DAYS = 366;

export interface Band {
  readonly day: string;
  readonly n: number;
  readonly min: number;
  readonly median: number;
  readonly max: number;
  /** How many of the day's samples carry the stored artifact-suspected flag (the min, median and max include them). */
  readonly artifactSuspected: number;
  /** How many carry the stored late-arrival flag. */
  readonly lateArrival: number;
  readonly revision: number;
}

export interface Completeness {
  readonly requestedDays: number;
  readonly daysWithData: number;
  readonly missingDays: readonly string[];
  readonly pendingWindows: number;
  readonly lastComputedAt: string | null;
  readonly workerWatermark: string | null;
  readonly generatedAt: string;
}

export interface MetricInfo {
  readonly id: string;
  readonly display: string;
  readonly unit: string;
}

export interface BandsResponse {
  readonly patientId: string;
  readonly metric: MetricInfo;
  readonly from: string;
  readonly to: string;
  readonly dayDefinition: string;
  readonly bands: readonly Band[];
  readonly completeness: Completeness;
}

export class TrendShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TrendShapeError";
  }
}

/** What a band looks like before it is validated. */
interface RawBand {
  day: unknown; n: unknown; min: unknown; median: unknown; max: unknown; artifactSuspected: unknown; lateArrival: unknown; revision: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/**
 * Validates an API answer rather than casting it: a response that is not the documented shape is an error the user
 * is told about, never a chart of whatever happened to be there.
 */
export function parseBands(raw: unknown): BandsResponse {
  if (!isRecord(raw)) throw new TrendShapeError("The response is not an object.");
  const { patientId, metric, from, to, dayDefinition, bands, completeness } = raw;
  if (typeof patientId !== "string") throw new TrendShapeError("patientId is missing.");
  if (!isRecord(metric) || typeof metric["id"] !== "string" || typeof metric["display"] !== "string" || typeof metric["unit"] !== "string") {
    throw new TrendShapeError("metric is malformed.");
  }
  if (!isDay(from) || !isDay(to)) throw new TrendShapeError("from/to are not dates.");
  if (typeof dayDefinition !== "string") throw new TrendShapeError("dayDefinition is missing.");
  if (!Array.isArray(bands)) throw new TrendShapeError("bands is not a list.");
  if (!isRecord(completeness)) throw new TrendShapeError("completeness is missing.");

  const parsed: Band[] = bands.map((item: unknown) => {
    if (!isRecord(item)) throw new TrendShapeError("a band is malformed.");
    const b = item as unknown as RawBand;
    if (!isDay(b.day) || !finite(b.n) || !finite(b.min) || !finite(b.median) || !finite(b.max) || !finite(b.revision)) {
      throw new TrendShapeError("a band is malformed.");
    }
    if (!count(b.artifactSuspected) || !count(b.lateArrival)) {
      throw new TrendShapeError("a band's flag counts are missing or not whole numbers.");
    }
    if (b.artifactSuspected > b.n || b.lateArrival > b.n) {
      throw new TrendShapeError("a band counts more flagged samples than samples.");
    }
    if (b.day < from || b.day > to) throw new TrendShapeError("a band lies outside the requested range.");
    if (b.min > b.median || b.median > b.max) throw new TrendShapeError("a band is out of order (lowest, median, highest).");
    return {
      day: b.day, n: b.n, min: b.min, median: b.median, max: b.max,
      artifactSuspected: b.artifactSuspected, lateArrival: b.lateArrival, revision: b.revision,
    };
  });
  const days = parsed.map((b) => b.day);
  if (new Set(days).size !== days.length) throw new TrendShapeError("a day appears twice.");

  const c = completeness;
  const missing = c["missingDays"];
  if (!finite(c["requestedDays"]) || !finite(c["daysWithData"]) || !finite(c["pendingWindows"]) || !Array.isArray(missing) || !missing.every(isDay)) {
    throw new TrendShapeError("completeness is malformed.");
  }
  return {
    patientId,
    metric: { id: metric["id"] as string, display: metric["display"] as string, unit: metric["unit"] as string },
    from,
    to,
    dayDefinition,
    bands: parsed.sort((a, b) => (a.day < b.day ? -1 : 1)),
    completeness: {
      requestedDays: c["requestedDays"],
      daysWithData: c["daysWithData"],
      missingDays: missing as string[],
      pendingWindows: c["pendingWindows"],
      lastComputedAt: typeof c["lastComputedAt"] === "string" ? c["lastComputedAt"] : null,
      workerWatermark: typeof c["workerWatermark"] === "string" ? c["workerWatermark"] : null,
      generatedAt: typeof c["generatedAt"] === "string" ? c["generatedAt"] : "",
    },
  };
}

// --- UTC day arithmetic (the rollup day is the UTC day, assumption A6; nothing here uses the browser's zone) ---

export const dayToMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
export const msToDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => msToDay(dayToMs(day) + n * DAY_MS);
export const todayUtc = (now: Date): string => msToDay(now.getTime());

/** Every UTC day from `from` to `to` inclusive. Callers have validated the range. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = dayToMs(from); t <= dayToMs(to); t += DAY_MS) out.push(msToDay(t));
  return out;
}

export type RangePreset = 7 | 14 | 30 | 90;
export const PRESETS: readonly RangePreset[] = [7, 14, 30, 90];

/** The `days` UTC days that end on `endDay` (inclusive). */
export function presetRange(days: RangePreset, endDay: string): { from: string; to: string } {
  return { from: addDays(endDay, -(days - 1)), to: endDay };
}

/** A sentence for the first problem with a custom range, or null when it is acceptable. */
export function validateRange(from: string, to: string): string | null {
  if (!isDay(from) || !isDay(to)) return "Enter both dates.";
  if (from > to) return "The start date is after the end date.";
  if ((dayToMs(to) - dayToMs(from)) / DAY_MS + 1 > MAX_RANGE_DAYS) return `Choose at most ${MAX_RANGE_DAYS} days.`;
  return null;
}

// --- chart data ---

/**
 * One value per requested day, in order. `null` is a day with no data: the chart must break its line there and the
 * table must say "No data". Nothing is ever filled in.
 */
export interface ChartData {
  readonly days: readonly string[];
  /** Day starts as Unix seconds (UTC midnight), the chart's x values. */
  readonly x: readonly number[];
  readonly n: ReadonlyArray<number | null>;
  readonly min: ReadonlyArray<number | null>;
  readonly median: ReadonlyArray<number | null>;
  readonly max: ReadonlyArray<number | null>;
  /** Per day: samples flagged as suspected artifacts, and samples flagged late (`null` on a day with no data). */
  readonly artifact: ReadonlyArray<number | null>;
  readonly late: ReadonlyArray<number | null>;
  /** Indices of days with data whose neighbours both have none: a line has nothing to join, so they need a marker. */
  readonly isolated: readonly number[];
  readonly missing: readonly string[];
  /** True when every day with data holds one sample (a daily value such as resting heart rate): show points, not a band. */
  readonly pointsOnly: boolean;
}

export function buildChartData(response: Pick<BandsResponse, "from" | "to" | "bands">): ChartData {
  const days = daysBetween(response.from, response.to);
  const byDay = new Map(response.bands.map((b) => [b.day, b]));
  const pick = (f: (b: Band) => number): Array<number | null> => days.map((d) => { const b = byDay.get(d); return b ? f(b) : null; });
  const n = pick((b) => b.n);
  const median = pick((b) => b.median);
  const has = (i: number) => median[i] !== null && median[i] !== undefined;
  const isolated: number[] = [];
  for (let i = 0; i < days.length; i++) {
    if (has(i) && !(i > 0 && has(i - 1)) && !(i < days.length - 1 && has(i + 1))) isolated.push(i);
  }
  const present = response.bands;
  return {
    days,
    x: days.map((d) => dayToMs(d) / 1000),
    n,
    min: pick((b) => b.min),
    median,
    max: pick((b) => b.max),
    artifact: pick((b) => b.artifactSuspected),
    late: pick((b) => b.lateArrival),
    isolated,
    missing: days.filter((d) => !byDay.has(d)),
    pointsOnly: present.length > 0 && present.every((b) => b.n === 1),
  };
}

/** Consecutive missing days collapsed to ranges: ["2026-09-20 to 2026-10-05", "2026-10-13"]. */
export function missingRanges(missing: readonly string[]): string[] {
  const out: string[] = [];
  let start: string | undefined;
  let prev: string | undefined;
  const flush = () => {
    if (start === undefined || prev === undefined) return;
    out.push(start === prev ? start : `${start} to ${prev}`);
  };
  for (const d of missing) {
    if (prev !== undefined && addDays(prev, 1) === d) {
      prev = d;
    } else {
      flush();
      start = d;
      prev = d;
    }
  }
  flush();
  return out;
}

/** Up to one decimal, without a trailing ".0": 50.6, 128, 66.1 (the values are measured to a tenth at most). */
const fmt = (v: number): string => String(Math.round(v * 10) / 10);
export const formatValue = fmt;

/**
 * One sentence on stored data-quality flags in the range, or `null` when none were stored. It says what the range
 * includes: a flag is a suspicion that travels with the value, and the min, median and max still contain it.
 */
export function flagNotice(data: Pick<ChartData, "artifact" | "late" | "days">): string | null {
  const artifactDays = data.artifact.filter((v) => v !== null && v > 0).length;
  const lateDays = data.late.filter((v) => v !== null && v > 0).length;
  const parts: string[] = [];
  if (artifactDays > 0) {
    const total = data.artifact.reduce<number>((a, v) => a + (v ?? 0), 0);
    parts.push(`${total} ${total === 1 ? "value" : "values"} on ${artifactDays} ${artifactDays === 1 ? "day" : "days"} flagged as suspected artifacts (included in the range shown)`);
  }
  if (lateDays > 0) {
    const total = data.late.reduce<number>((a, v) => a + (v ?? 0), 0);
    parts.push(`${total} ${total === 1 ? "sample" : "samples"} on ${lateDays} ${lateDays === 1 ? "day" : "days"} flagged as late arrivals`);
  }
  return parts.length === 0 ? null : `${parts.join("; ")}.`;
}

/** The screen-reader text for a chart: what is plotted, the range, the extremes, and what is missing, in words. */
export function summarize(metric: MetricInfo, data: ChartData, from: string, to: string): string {
  const withData = data.days.length - data.missing.length;
  if (withData === 0) {
    return `${metric.display}: no data in ${data.days.length} days from ${from} to ${to}.`;
  }
  const mins = data.min.filter((v): v is number => v !== null);
  const maxs = data.max.filter((v): v is number => v !== null);
  const medians = data.median.filter((v): v is number => v !== null);
  const lo = Math.min(...mins);
  const hi = Math.max(...maxs);
  const firstDay = data.days[data.median.findIndex((v) => v !== null)]!;
  const lastDay = data.days[data.median.length - 1 - [...data.median].reverse().findIndex((v) => v !== null)]!;
  const parts = [
    `${metric.display}, ${withData} of ${data.days.length} days with data from ${from} to ${to} (UTC days).`,
    data.pointsOnly
      ? `One value a day, from ${fmt(Math.min(...medians))} to ${fmt(Math.max(...medians))} ${metric.unit}.`
      : `Daily range from a lowest of ${fmt(lo)} to a highest of ${fmt(hi)} ${metric.unit}; daily medians from ${fmt(Math.min(...medians))} to ${fmt(Math.max(...medians))}.`,
    `First data ${firstDay}, last data ${lastDay}.`,
  ];
  if (data.missing.length > 0) {
    parts.push(`${data.missing.length} days have no data: ${missingRanges(data.missing).join(", ")}. They are shown as gaps, not estimated.`);
  } else {
    parts.push("Every day has data.");
  }
  // data-quality flags are announced once, by their own paragraph (`flagNotice`), not repeated here
  return parts.join(" ");
}

// --- the contract check ---

export interface MetricMismatch {
  readonly id: string;
  readonly problem: string;
}

/**
 * Compares what the analytic API says it can band with the contract this app was built against. A difference is shown
 * to the user (the chart's unit would otherwise be a claim nobody checked); it is not silently corrected.
 */
export function compareMetrics(
  api: readonly MetricInfo[],
  contract: ReadonlyArray<{ id: string; unit: string }>,
): MetricMismatch[] {
  const out: MetricMismatch[] = [];
  for (const c of contract) {
    const a = api.find((m) => m.id === c.id);
    if (!a) out.push({ id: c.id, problem: "the analytic service does not offer this metric" });
    else if (a.unit !== c.unit) out.push({ id: c.id, problem: `the analytic service reports unit ${a.unit}, the contract says ${c.unit}` });
  }
  for (const a of api) {
    if (!contract.some((c) => c.id === a.id)) out.push({ id: a.id, problem: "the analytic service offers a metric this app's contract does not know" });
  }
  return out;
}
