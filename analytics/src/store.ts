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
}

export interface StoredRollup extends Rollup {
  /** Starts at 1; incremented only when the stored values actually change. */
  readonly revision: number;
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
}

export class MemoryStore implements Store {
  private readonly watermarks = new Map<string, number>();
  private readonly touched = new Map<string, Window>();
  private readonly stored = new Map<string, StoredRollup>();

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
    if (existing && existing.unit === rollup.unit && existing.n === rollup.n && existing.min === rollup.min &&
        existing.median === rollup.median && existing.max === rollup.max) {
      return false;
    }
    this.stored.set(key, { ...rollup, revision: (existing?.revision ?? 0) + 1 });
    return true;
  }

  async rollups(patientId?: string): Promise<StoredRollup[]> {
    return [...this.stored.values()]
      .filter((r) => patientId === undefined || r.patientId === patientId)
      .sort((a, b) => windowKey(a).localeCompare(windowKey(b)));
  }
}
