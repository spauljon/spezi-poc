/**
 * The sleep view's data model (M16): one night's stage intervals, resolved into a single timeline, and the numbers
 * and words that come from it. Pure functions: no DOM, no I/O.
 *
 * The rules mirror the analytic worker's (analytics/src/sleep.ts, M10) so that the hypnogram and the API's summary
 * agree, and a live test holds them to it: every instant gets ONE stage, the interval that STARTS later wins, ties go
 * to the more specific stage and then the lower id; awake time of 5 minutes or more strictly between onset and final
 * waking is an awakening. Times are shown AS RECORDED (the device's own offset, which the sample carries); nothing
 * here converts to the browser's zone.
 */
import type { WebContract } from "../contract.ts";
import type { Observation } from "../fhir/types.ts";

export const MS_PER_MIN = 60_000;
export const MIN_AWAKENING_MIN = 5;

/** Most specific first; the tie-break between two intervals that start together (as in the worker). */
const SPECIFICITY = ["asleepDeep", "asleepREM", "asleepCore", "awake", "asleepUnspecified"] as const;
export const ASLEEP_STAGES = ["asleepCore", "asleepDeep", "asleepREM", "asleepUnspecified"] as const;
export type AsleepStage = (typeof ASLEEP_STAGES)[number];

/** The display taxonomy, top lane first. `asleepCore` is shown as "Light" (contract A4: a clinical judgment). */
export const LANE_ORDER = ["awake", "asleepREM", "asleepCore", "asleepDeep", "asleepUnspecified"] as const;
export const STAGE_LABEL: Readonly<Record<string, string>> = {
  awake: "Awake",
  asleepREM: "REM",
  asleepCore: "Light",
  asleepDeep: "Deep",
  asleepUnspecified: "Asleep (unspecified)",
};

export interface StageInterval {
  readonly id: string;
  readonly stage: string;
  readonly startMs: number;
  readonly endMs: number;
  /** The dateTime strings as recorded, with their own offsets. */
  readonly start: string;
  readonly end: string;
}

export type SkipReason = "retracted" | "unknownStage" | "noPeriod" | "empty";

export function toStageInterval(o: Observation, contract: WebContract): StageInterval | SkipReason {
  if (o.status === "entered-in-error") return "retracted";
  const code = o.code?.coding?.find((c) => c.system === contract.loincSystem)?.code;
  const stage = contract.sleepStages.find((s) => s.loincCode === code);
  if (!stage) return "unknownStage";
  const start = o.effectivePeriod?.start;
  const end = o.effectivePeriod?.end;
  if (!start || !end) return "noPeriod";
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs) return "empty";
  return { id: o.id ?? `${stage.id}-${startMs}`, stage: stage.id, startMs, endMs, start, end };
}

export interface Segment {
  readonly startMs: number;
  readonly endMs: number;
  /** The winning stage, or null where no interval covers the time (unscored). */
  readonly stage: string | null;
  /** How many intervals cover it (more than one is an overlap, resolved by the rule above). */
  readonly covered: number;
  /** The interval it comes from (null when unscored): adjacent pieces of one interval are joined. */
  readonly source: StageInterval | null;
}

const rank = (stage: string): number => {
  const i = SPECIFICITY.indexOf(stage as (typeof SPECIFICITY)[number]);
  return i < 0 ? SPECIFICITY.length : i;
};

/** Every instant from the first start to the last end, resolved to one stage (or none). Boundaries are exact. */
export function resolveTimeline(intervals: readonly StageInterval[]): Segment[] {
  if (intervals.length === 0) return [];
  const bounds = [...new Set(intervals.flatMap((i) => [i.startMs, i.endMs]))].sort((a, b) => a - b);
  const out: Segment[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const a = bounds[k]!;
    const b = bounds[k + 1]!;
    const covering = intervals.filter((i) => i.startMs <= a && i.endMs >= b);
    const winner = [...covering].sort((x, y) => y.startMs - x.startMs || rank(x.stage) - rank(y.stage) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0] ?? null;
    const prev = out[out.length - 1];
    if (prev && prev.endMs === a && prev.source === winner && prev.covered === covering.length) {
      out[out.length - 1] = { ...prev, endMs: b };
    } else {
      out.push({ startMs: a, endMs: b, stage: winner?.stage ?? null, covered: covering.length, source: winner });
    }
  }
  return out;
}

export interface NightStats {
  readonly startMs: number;
  readonly endMs: number;
  readonly onsetMs: number | null;
  readonly finalWakingMs: number | null;
  readonly latencyMin: number;
  readonly wakeAfterEndMin: number;
  readonly asleepMin: number;
  readonly coreMin: number;
  readonly deepMin: number;
  readonly remMin: number;
  readonly unspecifiedMin: number;
  readonly awakeMin: number;
  readonly unscoredMin: number;
  readonly overlapMin: number;
  readonly awakenings: number;
}

const mins = (ms: number) => ms / MS_PER_MIN;

/** The summary of a resolved timeline, computed the way the worker defines it (so the two can be compared). */
export function nightStats(segments: readonly Segment[]): NightStats | null {
  if (segments.length === 0) return null;
  const startMs = segments[0]!.startMs;
  const endMs = segments[segments.length - 1]!.endMs;
  const asleep = segments.filter((s) => s.stage !== null && (ASLEEP_STAGES as readonly string[]).includes(s.stage));
  if (asleep.length === 0) {
    return {
      startMs, endMs, onsetMs: null, finalWakingMs: null, latencyMin: 0, wakeAfterEndMin: 0, asleepMin: 0, coreMin: 0, deepMin: 0,
      remMin: 0, unspecifiedMin: 0, awakeMin: 0, unscoredMin: 0, overlapMin: 0, awakenings: 0,
    };
  }
  const onsetMs = asleep[0]!.startMs;
  const finalWakingMs = asleep[asleep.length - 1]!.endMs;
  const inside = segments.filter((s) => s.startMs >= onsetMs && s.endMs <= finalWakingMs);
  const sum = (pred: (s: Segment) => boolean) => mins(inside.filter(pred).reduce((n, s) => n + (s.endMs - s.startMs), 0));
  const stageMin = (stage: string) => sum((s) => s.stage === stage);

  // awakenings: contiguous awake time (adjacent awake pieces count as one) of at least 5 minutes between onset and waking
  let awakenings = 0;
  let runStart: number | null = null;
  let runEnd = 0;
  const closeRun = () => {
    if (runStart !== null && mins(runEnd - runStart) >= MIN_AWAKENING_MIN) awakenings++;
    runStart = null;
  };
  for (const s of inside) {
    if (s.stage === "awake") {
      if (runStart !== null && s.startMs === runEnd) runEnd = s.endMs;
      else { closeRun(); runStart = s.startMs; runEnd = s.endMs; }
    } else {
      closeRun();
    }
  }
  closeRun();

  return {
    startMs, endMs, onsetMs, finalWakingMs,
    latencyMin: mins(onsetMs - startMs),
    wakeAfterEndMin: mins(endMs - finalWakingMs),
    asleepMin: sum((s) => s.stage !== null && (ASLEEP_STAGES as readonly string[]).includes(s.stage)),
    coreMin: stageMin("asleepCore"), deepMin: stageMin("asleepDeep"), remMin: stageMin("asleepREM"), unspecifiedMin: stageMin("asleepUnspecified"),
    awakeMin: stageMin("awake"),
    unscoredMin: sum((s) => s.stage === null),
    overlapMin: sum((s) => s.covered > 1),
    awakenings,
  };
}

// --- time as recorded ---

export interface Recorded {
  /** `YYYY-MM-DD` on the device's clock. */
  readonly date: string;
  readonly hhmm: string;
  /** `+hh:mm` or `-hh:mm` (a `Z` is read as `+00:00`). */
  readonly offset: string;
  /** The device's wall clock as if it were UTC, for clock arithmetic only. */
  readonly wallMs: number;
}

export function recorded(iso: string): Recorded | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(iso);
  if (!m) return null;
  const [, y, mo, d, h, mi, s = "00", off] = m;
  return {
    date: `${y}-${mo}-${d}`,
    hhmm: `${h}:${mi}`,
    offset: off === "Z" ? "+00:00" : off!,
    wallMs: Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)),
  };
}

export const offsetLabel = (offset: string): string => `UTC${offset}`;

/** Distinct offsets in the order they occur in the night: more than one means the device's clock changed. */
export function offsetsIn(intervals: readonly StageInterval[]): string[] {
  const seen: string[] = [];
  const ordered = [...intervals].sort((a, b) => a.startMs - b.startMs);
  for (const iv of ordered) {
    for (const t of [iv.start, iv.end]) {
      const r = recorded(t);
      if (r && !seen.includes(r.offset)) seen.push(r.offset);
    }
  }
  return seen;
}

/** True for an interval whose own start and end offsets differ: the clock changed inside it. */
export const spansClockChange = (iv: StageInterval): boolean => {
  const a = recorded(iv.start);
  const b = recorded(iv.end);
  return !!a && !!b && a.offset !== b.offset;
};

const pad2 = (n: number) => String(n).padStart(2, "0");
const shifted = (r: Recorded, deltaMs: number): { hhmm: string; offset: string } => {
  const d = new Date(r.wallMs + deltaMs);
  return { hhmm: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`, offset: r.offset };
};

/**
 * The device clock at an instant, as "HH:MM" with its offset, or null when the data does not pin it down: inside an
 * interval across which the clock changed (it does not say WHEN inside it), or in a gap whose two sides disagree.
 * No clock time is invented for such an instant.
 */
export function clockAt(ms: number, intervals: readonly StageInterval[]): { hhmm: string; offset: string } | null {
  const ordered = [...intervals].sort((a, b) => a.startMs - b.startMs);
  for (const iv of ordered) {
    if (iv.startMs === ms) { const r = recorded(iv.start); return r ? shifted(r, 0) : null; }
    if (iv.endMs === ms) { const r = recorded(iv.end); return r ? shifted(r, 0) : null; }
  }
  const inside = ordered.find((i) => i.startMs < ms && ms < i.endMs);
  if (inside) {
    if (spansClockChange(inside)) return null;
    const r = recorded(inside.start);
    return r ? shifted(r, ms - inside.startMs) : null;
  }
  const before = [...ordered].reverse().find((i) => i.endMs < ms);
  const after = ordered.find((i) => i.startMs > ms);
  const a = before ? recorded(before.end) : null;
  const b = after ? recorded(after.start) : null;
  if (before && after) {
    if (!a || !b || a.offset !== b.offset) return null;
    return shifted(a, ms - before.endMs);
  }
  if (before && a) return shifted(a, ms - before.endMs);
  if (after && b) return shifted(b, ms - after.startMs);
  return null;
}

export interface ClockNote {
  readonly offsets: readonly string[];
  /** Wall-clock length of the session minus its real length, in minutes (zero when the clock did not change). */
  readonly clockMinusElapsedMin: number;
}

export function clockNote(intervals: readonly StageInterval[], startMs: number, endMs: number): ClockNote {
  const offsets = offsetsIn(intervals);
  const ordered = [...intervals].sort((a, b) => a.startMs - b.startMs);
  const first = ordered.find((i) => i.startMs === startMs);
  const last = [...ordered].reverse().find((i) => i.endMs === endMs);
  const a = first ? recorded(first.start) : null;
  const b = last ? recorded(last.end) : null;
  if (!a || !b) return { offsets, clockMinusElapsedMin: 0 };
  return { offsets, clockMinusElapsedMin: mins(b.wallMs - a.wallMs) - mins(endMs - startMs) };
}

// --- words ---

export const minutesText = (m: number): string => {
  const r = Math.round(m);
  return r >= 60 ? `${Math.floor(r / 60)} h ${String(r % 60).padStart(2, "0")} min` : `${r} min`;
};

/** The sentence a screen reader gets for a night (and everyone gets above the chart). */
export function nightSummary(stats: NightStats, intervals: readonly StageInterval[], isMain: boolean): string {
  const rec = (ms: number) => {
    const c = clockAt(ms, intervals);
    return c ? `${c.hhmm} (${offsetLabel(c.offset)})` : "a time inside the clock change";
  };
  if (stats.onsetMs === null || stats.finalWakingMs === null) {
    return `${isMain ? "Night" : "Nap"}: no asleep stage recorded.`;
  }
  const parts = [
    `${isMain ? "Night" : "Nap"}: asleep ${minutesText(stats.asleepMin)} from ${rec(stats.onsetMs)} to ${rec(stats.finalWakingMs)}.`,
    `Light ${minutesText(stats.coreMin)}, deep ${minutesText(stats.deepMin)}, REM ${minutesText(stats.remMin)}${stats.unspecifiedMin > 0 ? `, unspecified ${minutesText(stats.unspecifiedMin)}` : ""}.`,
    `${stats.awakenings} ${stats.awakenings === 1 ? "awakening" : "awakenings"} (awake ${minutesText(stats.awakeMin)} in total between onset and waking); ${minutesText(stats.latencyMin)} to fall asleep, ${minutesText(stats.wakeAfterEndMin)} awake after the final waking.`,
  ];
  if (stats.unscoredMin > 0) parts.push(`${minutesText(stats.unscoredMin)} inside the night has no recorded stage.`);
  if (stats.overlapMin > 0) parts.push(`${minutesText(stats.overlapMin)} is covered by more than one interval; the interval that starts later is shown.`);
  const note = clockNote(intervals, stats.startMs, stats.endMs);
  if (note.offsets.length > 1) {
    const diff = Math.round(note.clockMinusElapsedMin);
    parts.push(
      `The device's clock offset changed during this night (${note.offsets.map(offsetLabel).join(" then ")}): the night spans ${minutesText(mins(stats.endMs - stats.startMs))} of real time, ${minutesText(mins(stats.endMs - stats.startMs) + diff)} on the clock.`,
    );
  }
  return parts.join(" ");
}
