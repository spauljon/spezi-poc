/**
 * Nightly sleep summaries from stage intervals: pure functions, no I/O.
 *
 * Rules (decided for M10; assumptions A37 to A42 in the README):
 *  - Instants are epoch milliseconds; the night's date is the UTC date of the final waking from sleep.
 *  - Overlaps are resolved so that every instant has at most one stage: the interval that STARTS later wins; ties go
 *    to the more specific stage, then to the lower id. The overlapped time is reported, never hidden.
 *  - A session is a run of intervals with no gap longer than SESSION_GAP_MS.
 *  - A session with no asleep stage is not sleep and produces no row.
 *  - Awakenings are awake stretches strictly between sleep onset and the final waking that last at least
 *    MIN_AWAKENING_MS (shorter ones add to awake time only).
 *  - Per date, the session with the most time asleep is the main sleep; the rest are naps (reported, not hidden).
 */

export const SESSION_GAP_MS = 2 * 60 * 60 * 1000;
export const MIN_AWAKENING_MS = 5 * 60 * 1000;
export const MS_PER_MIN = 60_000;

/** Contract stage ids this module can classify. A contract stage not listed here must fail loudly (see tests). */
export const ASLEEP_STAGES = ["asleepCore", "asleepDeep", "asleepREM", "asleepUnspecified"] as const;
export const AWAKE_STAGE = "awake";
/** Tie-break when two overlapping intervals start together: lower index wins. */
const SPECIFICITY = ["asleepDeep", "asleepREM", "asleepCore", AWAKE_STAGE, "asleepUnspecified"];

export interface StageInterval {
  readonly id: string;
  readonly stage: string;
  readonly startMs: number;
  readonly endMs: number;
}

export interface SleepSession {
  readonly patientId: string;
  /** `YYYY-MM-DD`, UTC date of `lastAsleepEndMs`. */
  readonly night: string;
  readonly sessionStartMs: number;
  readonly sessionEndMs: number;
  readonly onsetMs: number;
  readonly lastAsleepEndMs: number;
  /** Session start to onset (awake time before falling asleep). */
  readonly latencyMin: number;
  /** Last asleep end to session end (awake time after the final waking). */
  readonly wakeAfterEndMin: number;
  readonly asleepMin: number;
  readonly coreMin: number;
  readonly deepMin: number;
  readonly remMin: number;
  readonly unspecifiedMin: number;
  /** Awake time between onset and final waking. */
  readonly awakeMin: number;
  /** Time between onset and final waking covered by no interval. */
  readonly unscoredMin: number;
  /** Time covered by more than one interval (resolved by the rule above). */
  readonly overlapMin: number;
  readonly awakenings: number;
  readonly intervalCount: number;
  readonly isMain: boolean;
}

interface Segment {
  startMs: number;
  endMs: number;
  stage: string;
}

const rank = (stage: string): number => {
  const i = SPECIFICITY.indexOf(stage);
  return i === -1 ? SPECIFICITY.length : i;
};

/** One stage per instant. Returns segments (sorted, non-overlapping, touching equal stages merged) and overlapped ms. */
export function resolve(intervals: readonly StageInterval[]): { segments: Segment[]; overlapMs: number } {
  const usable = intervals.filter((i) => Number.isFinite(i.startMs) && Number.isFinite(i.endMs) && i.endMs > i.startMs);
  const points = [...new Set(usable.flatMap((i) => [i.startMs, i.endMs]))].sort((a, b) => a - b);
  const segments: Segment[] = [];
  let overlapMs = 0;
  for (let k = 0; k + 1 < points.length; k++) {
    const a = points[k]!;
    const b = points[k + 1]!;
    const covering = usable.filter((i) => i.startMs <= a && i.endMs >= b);
    if (covering.length === 0) {
      continue;
    }
    if (covering.length > 1) {
      overlapMs += b - a;
    }
    covering.sort((x, y) => y.startMs - x.startMs || rank(x.stage) - rank(y.stage) || x.id.localeCompare(y.id));
    const stage = covering[0]!.stage;
    const last = segments[segments.length - 1];
    if (last && last.endMs === a && last.stage === stage) {
      last.endMs = b;
    } else {
      segments.push({ startMs: a, endMs: b, stage });
    }
  }
  return { segments, overlapMs };
}

const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const min = (ms: number): number => ms / MS_PER_MIN;

/** All sleep sessions in `intervals` (one patient), with the main sleep per night flagged. */
export function buildSessions(patientId: string, intervals: readonly StageInterval[]): SleepSession[] {
  const known = new Set<string>([...ASLEEP_STAGES, AWAKE_STAGE]);
  const usable = intervals.filter((i) => known.has(i.stage));
  const { segments } = resolve(usable);

  // cluster resolved segments into sessions by gap
  const clusters: Segment[][] = [];
  for (const seg of segments) {
    const current = clusters[clusters.length - 1];
    const prev = current?.[current.length - 1];
    if (current && prev && seg.startMs - prev.endMs <= SESSION_GAP_MS) {
      current.push(seg);
    } else {
      clusters.push([seg]);
    }
  }

  const sessions: Omit<SleepSession, "isMain">[] = [];
  for (const cluster of clusters) {
    const asleep = cluster.filter((s) => s.stage !== AWAKE_STAGE);
    if (asleep.length === 0) {
      continue;
    }
    const sessionStartMs = cluster[0]!.startMs;
    const sessionEndMs = cluster[cluster.length - 1]!.endMs;
    const onsetMs = asleep[0]!.startMs;
    const lastAsleepEndMs = asleep[asleep.length - 1]!.endMs;
    const period = cluster.filter((s) => s.startMs >= onsetMs && s.endMs <= lastAsleepEndMs);
    const total = (stage: string) =>
      period.filter((s) => s.stage === stage).reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
    const covered = period.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
    const awakeMs = total(AWAKE_STAGE);
    const asleepMs = ASLEEP_STAGES.reduce((sum, stage) => sum + total(stage), 0);
    const awakenings = period.filter(
      (s) => s.stage === AWAKE_STAGE && s.endMs - s.startMs >= MIN_AWAKENING_MS).length;
    const overlapMs = resolve(
      usable.filter((i) => i.endMs > sessionStartMs && i.startMs < sessionEndMs),
    ).overlapMs;
    sessions.push({
      patientId,
      night: day(lastAsleepEndMs),
      sessionStartMs,
      sessionEndMs,
      onsetMs,
      lastAsleepEndMs,
      latencyMin: min(onsetMs - sessionStartMs),
      wakeAfterEndMin: min(sessionEndMs - lastAsleepEndMs),
      asleepMin: min(asleepMs),
      coreMin: min(total("asleepCore")),
      deepMin: min(total("asleepDeep")),
      remMin: min(total("asleepREM")),
      unspecifiedMin: min(total("asleepUnspecified")),
      awakeMin: min(awakeMs),
      unscoredMin: min(lastAsleepEndMs - onsetMs - covered),
      overlapMin: min(overlapMs),
      awakenings,
      intervalCount: usable.filter((i) => i.endMs > sessionStartMs && i.startMs < sessionEndMs).length,
    });
  }

  // main sleep per night: most time asleep, then the earlier session
  const mainStart = new Map<string, number>();
  for (const s of sessions) {
    const best = sessions
      .filter((o) => o.night === s.night)
      .sort((a, b) => b.asleepMin - a.asleepMin || a.sessionStartMs - b.sessionStartMs)[0]!;
    mainStart.set(s.night, best.sessionStartMs);
  }
  return sessions.map((s) => ({ ...s, isMain: mainStart.get(s.night) === s.sessionStartMs }));
}

/**
 * The night dates whose summaries could change when an interval [startMs, endMs) is added or changed: a new
 * interval can extend a session, bridge two sessions into one (deleting one row and changing another), or start a new
 * one. Sessions are bounded in practice by 24 hours, so every date within 26 hours either side is recomputed.
 */
export function affectedNights(startMs: number, endMs: number): string[] {
  const margin = 26 * 60 * 60 * 1000;
  const first = Date.parse(`${day(startMs - margin)}T00:00:00.000Z`);
  const last = Date.parse(`${day(endMs + margin)}T00:00:00.000Z`);
  const out: string[] = [];
  for (let t = first; t <= last; t += 86_400_000) {
    out.push(day(t));
  }
  return out;
}

/** The interval a recompute of `night` must read, padded so sessions that end on `night` are complete. */
export function fetchRange(night: string): { fromMs: number; toMs: number } {
  const start = Date.parse(`${night}T00:00:00.000Z`);
  return { fromMs: start - 2 * 86_400_000, toMs: start + 3 * 86_400_000 };
}
