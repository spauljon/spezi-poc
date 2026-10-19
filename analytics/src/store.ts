import type { SleepSession } from "./sleep.ts";

/** A patient, metric and UTC day: the unit that is recomputed as a whole. */
export interface Window {
  readonly patientId: string;
  readonly metricId: string;
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
}

export interface Rollup extends Window {
  readonly unit: string;
  readonly n: number;
  readonly min: number;
  readonly median: number;
  readonly max: number;
  /** How many of the day's samples carry the artifact-suspected flag (stored tag; the bands include them). */
  readonly nArtifact: number;
  /** How many carry the late-arrival flag. */
  readonly nLate: number;
}

export interface StoredRollup extends Rollup {
  /** Starts at 1; incremented only when the stored values actually change. */
  readonly revision: number;
  /** When the stored values last changed (epoch ms; Oracle keeps whole seconds). */
  readonly updatedAtMs: number;
}

export const windowKey = (w: Window): string => `${w.patientId}|${w.metricId}|${w.day}`;

/**
 * Persistence for the worker. Implemented by Oracle (`oracle-store.ts`) and by an in-memory twin for tests; both are
 * held to the same behavior by the shared test suite.
 */
export interface Store {
  /** Epoch milliseconds of the newest `meta.lastUpdated` seen, or `null` if the worker has never run. */
  getWatermark(worker: string): Promise<number | null>;

  /**
   * In ONE transaction: remember `windows` as touched (already-pending ones are left alone) and move the watermark
   * forward (never backward). Either both happen or neither does.
   */
  recordTouched(worker: string, windows: readonly Window[], watermarkMs: number | null): Promise<void>;

  pendingWindows(limit: number): Promise<Window[]>;

  /**
   * In ONE transaction: write the window's rollup (or delete it when `rollup` is `null`) and clear its touched mark.
   * An upsert with identical values changes nothing, including the revision.
   * @returns whether the stored rollup changed.
   */
  applyRollup(window: Window, rollup: Rollup | null): Promise<boolean>;

  rollups(patientId?: string): Promise<StoredRollup[]>;

  /**
   * In ONE transaction: make the stored sleep sessions of (patient, night) exactly `sessions` (insert, change or
   * delete as needed) and clear the window's touched mark. Sessions whose values are identical are left alone,
   * revision included.
   * @returns whether anything stored changed.
   */
  applyNights(window: Window, sessions: readonly SleepSession[]): Promise<boolean>;

  nights(patientId?: string): Promise<StoredSleepSession[]>;
}

export interface StoredSleepSession extends SleepSession {
  readonly revision: number;
  readonly updatedAtMs: number;
}

/** What the analytic API reads (never writes). Implemented by Oracle and by the in-memory store. */
export interface Reader {
  bands(patientId: string, metricId: string, from: string, to: string): Promise<StoredRollup[]>;
  sleepNights(patientId: string, from: string, to: string): Promise<StoredSleepSession[]>;
  /** Touched windows not yet recomputed (stale risk) in the range, for the patient and metrics. */
  pendingCount(patientId: string, metricIds: readonly string[], from: string, to: string): Promise<number>;
  getWatermark(worker: string): Promise<number | null>;
}

/** Equality of everything but the revision. */
export function sameSession(a: SleepSession, b: SleepSession): boolean {
  // `a` may be a stored row carrying a revision; compare only the session's own fields
  const keys = Object.keys(b) as (keyof SleepSession)[];
  return keys.every((k) => a[k] === b[k]);
}

export class MemoryStore implements Store, Reader {
  constructor(private readonly clock: () => number = Date.now) {}

  private readonly watermarks = new Map<string, number>();
  private readonly touched = new Map<string, Window>();
  private readonly stored = new Map<string, StoredRollup>();
  private readonly sessions = new Map<string, StoredSleepSession>();

  async getWatermark(worker: string): Promise<number | null> {
    return this.watermarks.get(worker) ?? null;
  }

  async recordTouched(worker: string, windows: readonly Window[], watermarkMs: number | null): Promise<void> {
    for (const w of windows) {
      if (!this.touched.has(windowKey(w))) {
        this.touched.set(windowKey(w), w);
      }
    }
    if (watermarkMs !== null && watermarkMs > (this.watermarks.get(worker) ?? -Infinity)) {
      this.watermarks.set(worker, watermarkMs);
    }
  }

  async pendingWindows(limit: number): Promise<Window[]> {
    return [...this.touched.values()].slice(0, limit);
  }

  async applyRollup(window: Window, rollup: Rollup | null): Promise<boolean> {
    const key = windowKey(window);
    this.touched.delete(key);
    const existing = this.stored.get(key);
    if (rollup === null) {
      return this.stored.delete(key);
    }
    if (existing?.unit === rollup.unit && existing.n === rollup.n && existing.min === rollup.min &&
        existing.median === rollup.median && existing.max === rollup.max &&
        existing.nArtifact === rollup.nArtifact && existing.nLate === rollup.nLate) {
      return false;
    }
    this.stored.set(key, { ...rollup, revision: (existing?.revision ?? 0) + 1, updatedAtMs: this.clock() });
    return true;
  }

  async applyNights(window: Window, sessions: readonly SleepSession[]): Promise<boolean> {
    this.touched.delete(windowKey(window));
    let changed = false;
    const keep = new Set<string>();
    for (const s of sessions) {
      const key = `${s.patientId}|${s.night}|${s.sessionStartMs}`;
      keep.add(key);
      const existing = this.sessions.get(key);
      if (existing && sameSession(existing, s)) {
        continue;
      }
      this.sessions.set(key, { ...s, revision: (existing?.revision ?? 0) + 1, updatedAtMs: this.clock() });
      changed = true;
    }
    for (const [key, s] of this.sessions) {
      if (s.patientId === window.patientId && s.night === window.day && !keep.has(key)) {
        this.sessions.delete(key);
        changed = true;
      }
    }
    return changed;
  }

  async nights(patientId?: string): Promise<StoredSleepSession[]> {
    return [...this.sessions.values()]
      .filter((s) => patientId === undefined || s.patientId === patientId)
      .sort((a, b) => a.patientId.localeCompare(b.patientId) || a.sessionStartMs - b.sessionStartMs);
  }

  async bands(patientId: string, metricId: string, from: string, to: string): Promise<StoredRollup[]> {
    return [...this.stored.values()]
      .filter((r) => r.patientId === patientId && r.metricId === metricId && r.day >= from && r.day <= to)
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  async sleepNights(patientId: string, from: string, to: string): Promise<StoredSleepSession[]> {
    return [...this.sessions.values()]
      .filter((s) => s.patientId === patientId && s.night >= from && s.night <= to)
      .sort((a, b) => a.sessionStartMs - b.sessionStartMs);
  }

  async pendingCount(patientId: string, metricIds: readonly string[], from: string, to: string): Promise<number> {
    return [...this.touched.values()].filter(
      (w) => w.patientId === patientId && metricIds.includes(w.metricId) && w.day >= from && w.day <= to).length;
  }

  async rollups(patientId?: string): Promise<StoredRollup[]> {
    return [...this.stored.values()]
      .filter((r) => patientId === undefined || r.patientId === patientId)
      .sort((a, b) => windowKey(a).localeCompare(windowKey(b)));
  }
}
