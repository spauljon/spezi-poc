import type { MealTypes } from "./contract.ts";
import type { Window } from "./store.ts";

/** The row that holds the whole day's total. The other rows split it by meal. */
export const MEAL_ALL = "all";
/** Entries that carry no meal label (absence is never invented as a meal). */
export const MEAL_NONE = "unlabelled";

/** One stored, final intake Observation as the daily total sees it. */
export interface IntakeEntry {
  readonly id: string;
  /** Amount, in the contract's unit. Finite and not negative (the caller checked). */
  readonly value: number;
  /** The entry's own instant (epoch ms), for the first and last time of day. */
  readonly instantMs: number;
  /** The contract's meal code, or `null` when the entry has none. */
  readonly meal: string | null;
  readonly artifactSuspected: boolean;
  readonly lateArrival: boolean;
}

/** A day's total for one nutrient, overall (`meal === MEAL_ALL`) or for one meal. */
export interface IntakeTotal extends Window {
  readonly meal: string;
  readonly unit: string;
  readonly total: number;
  /** Entries summed. A day with only zero entries has n > 0 and total 0: that is not the same as no entries. */
  readonly n: number;
  readonly firstMs: number;
  readonly lastMs: number;
  /** Entries carrying the stored artifact-suspected flag; the total includes them (a flag is a suspicion, not a removal). */
  readonly nArtifact: number;
  readonly nLate: number;
}

export interface StoredIntakeTotal extends IntakeTotal {
  readonly revision: number;
  readonly updatedAtMs: number;
}

const SCALE = 1_000_000;

/**
 * An exact decimal sum: each value is taken to six decimal places and added as an integer, so the order of the
 * entries and the float rounding of a running sum cannot change the answer (0.1 + 0.2 is 0.3 here).
 * Entries finer than 1e-6 of a unit are rounded; nothing in this domain is that fine.
 */
export function sumExact(values: readonly number[]): number {
  let scaled = 0;
  for (const v of values) {
    scaled += Math.round(v * SCALE);
  }
  return scaled / SCALE;
}

/** The meal bucket of an entry: its code, or the unlabelled bucket. */
export function mealKey(entry: IntakeEntry): string {
  return entry.meal ?? MEAL_NONE;
}

/**
 * The stored rows of one (patient, nutrient, day as recorded): the overall total, plus one row per meal bucket that
 * has entries. No entries gives no rows, which is how "no data" differs from a total of zero.
 */
export function totalsFor(window: Window, unit: string, entries: readonly IntakeEntry[]): IntakeTotal[] {
  if (entries.length === 0) {
    return [];
  }
  const row = (meal: string, group: readonly IntakeEntry[]): IntakeTotal => ({
    ...window,
    meal,
    unit,
    total: sumExact(group.map((e) => e.value)),
    n: group.length,
    firstMs: Math.min(...group.map((e) => e.instantMs)),
    lastMs: Math.max(...group.map((e) => e.instantMs)),
    nArtifact: group.filter((e) => e.artifactSuspected).length,
    nLate: group.filter((e) => e.lateArrival).length,
  });
  const buckets = new Map<string, IntakeEntry[]>();
  for (const e of entries) {
    const key = mealKey(e);
    buckets.set(key, [...(buckets.get(key) ?? []), e]);
  }
  return [row(MEAL_ALL, entries), ...[...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, g]) => row(k, g))];
}

/** A meal code from an Observation's `category`, as the contract's code, or `null` when it carries none. */
export function mealOf(
  categories: readonly { coding?: readonly { system?: string; code?: string }[] }[] | undefined,
  meals: MealTypes,
): string | null {
  for (const category of categories ?? []) {
    for (const coding of category.coding ?? []) {
      if (coding.system === meals.system && coding.code) {
        // a code this reader does not know is the contract's catch-all, never a new bucket
        return meals.codes.includes(coding.code) ? coding.code : meals.fallback;
      }
    }
  }
  return null;
}
