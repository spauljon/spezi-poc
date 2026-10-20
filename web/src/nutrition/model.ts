/**
 * The nutrition view's data model (M23): what the analytic API's daily totals become on screen. No DOM: the rules that
 * matter (a day with no entries is a gap and never a 0, a zero total is a day with entries, the meals add up to the
 * day, an estimate is labelled as one) are decided and tested here.
 */
import { formatValue } from "../format.ts";
import { daysBetween } from "../trends/model.ts";
import type { MealTotal, NutritionResponse } from "./api.ts";

/** The API's name for the part of a day made of entries that carry no meal (`analytics/src/intake.ts`, in openapi.json). */
export const UNLABELLED = "unlabelled";

export type DayCell =
  | { readonly kind: "none"; readonly day: string }
  | {
    readonly kind: "entries";
    readonly day: string;
    /** The sum of the day's entries. 0 is a real total (entries that sum to zero), never a stand-in for "none". */
    readonly total: number;
    readonly entries: number;
    readonly firstEntry: string;
    readonly lastEntry: string;
    readonly artifactSuspected: number;
    readonly lateArrival: number;
    readonly byMeal: readonly MealTotal[];
  };

/** One cell per requested day, in order. A day the API did not return is `none`: nothing is filled in. */
export function buildCells(response: Pick<NutritionResponse, "from" | "to" | "days">): DayCell[] {
  const byDay = new Map(response.days.map((d) => [d.day, d]));
  return daysBetween(response.from, response.to).map((day): DayCell => {
    const d = byDay.get(day);
    return d
      ? {
        kind: "entries", day, total: d.total, entries: d.entries, firstEntry: d.firstEntry, lastEntry: d.lastEntry,
        artifactSuspected: d.artifactSuspected, lateArrival: d.lateArrival, byMeal: d.byMeal,
      }
      : { kind: "none", day };
  });
}

export const withEntries = (cells: readonly DayCell[]) => cells.filter((c): c is Extract<DayCell, { kind: "entries" }> => c.kind === "entries");

/**
 * A scale that starts at 0 and ends on a round number at or above `max`, with its gridlines. Bars are drawn from 0 (a
 * truncated axis would exaggerate a day), so there is no other choice of start.
 */
export function niceScale(max: number): { readonly max: number; readonly ticks: readonly number[] } {
  if (!Number.isFinite(max) || max <= 0) return { max: 1, ticks: [0, 1] };
  const rough = max / 4;
  const pow = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= rough)!;
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 1e6; v += step) ticks.push(Math.round(v * 1e9) / 1e9);
  return { max: top, ticks };
}

/** The meal buckets present in these cells, in the contract's order and the unlabelled bucket last. */
export function mealKeys(cells: readonly DayCell[], contractMeals: readonly string[]): string[] {
  const present = new Set(withEntries(cells).flatMap((c) => c.byMeal.map((m) => m.meal)));
  const known = contractMeals.filter((m) => present.has(m));
  const unknown = [...present].filter((m) => m !== UNLABELLED && !contractMeals.includes(m)).sort();
  return [...known, ...unknown, ...(present.has(UNLABELLED) ? [UNLABELLED] : [])];
}

export const mealOf = (cell: Extract<DayCell, { kind: "entries" }>, meal: string): MealTotal | undefined =>
  cell.byMeal.find((m) => m.meal === meal);

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The chart in words: how many days have entries, the range of the totals, and what the empty slots mean. */
export function summaryText(label: string, unit: string, cells: readonly DayCell[]): string {
  const have = withEntries(cells);
  const none = cells.length - have.length;
  if (have.length === 0) {
    return `${label}: no entries on any of these ${cells.length} days. Empty slots mean nothing was recorded, not that the total was 0.`;
  }
  const totals = have.map((c) => c.total);
  const lo = Math.min(...totals);
  const hi = Math.max(...totals);
  const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
  const top = have.find((c) => c.total === hi)!;
  const zeros = have.filter((c) => c.total === 0).length;
  return [
    `${label}: ${have.length} of ${cells.length} days have entries.`,
    `On those days the daily total ranged from ${formatValue(lo)} to ${formatValue(hi)} ${unit}, averaging ${formatValue(avg)} ${unit} per day with entries;`,
    `the highest was ${top.day}.`,
    zeros > 0 ? `${plural(zeros, "day sums", "days sum")} to 0 (entries that add up to nothing).` : "",
    none > 0 ? `${plural(none, "day has", "days have")} no entries, shown as empty slots and left out of the average, not counted as 0.` : "",
  ].filter(Boolean).join(" ");
}

/** What the keyboard readout says about one day. */
export function readoutText(cell: DayCell, label: string, unit: string, mealLabel: (meal: string) => string): string {
  if (cell.kind === "none") return `${cell.day}: no entries (nothing recorded, not a total of 0).`;
  const meals = cell.byMeal.length > 1 || cell.byMeal[0]?.meal !== UNLABELLED
    ? `; ${cell.byMeal.map((m) => `${mealLabel(m.meal)} ${formatValue(m.total)}`).join(", ")}`
    : "";
  const flags = [
    cell.artifactSuspected > 0 ? `${cell.artifactSuspected} flagged as a suspected artifact` : "",
    cell.lateArrival > 0 ? `${cell.lateArrival} flagged as arriving late` : "",
  ].filter(Boolean);
  return `${cell.day}: ${label} ${formatValue(cell.total)} ${unit} from ${plural(cell.entries, "entry", "entries")}${meals}${flags.length ? `; ${flags.join(", ")}` : ""}.`;
}

/** One sentence about stored quality flags in the range, or null when none is stored. The totals include flagged entries. */
export function flagsNotice(cells: readonly DayCell[]): string | null {
  const have = withEntries(cells);
  const artifact = have.reduce((n, c) => n + c.artifactSuspected, 0);
  const late = have.reduce((n, c) => n + c.lateArrival, 0);
  const parts = [
    artifact > 0 ? `${plural(artifact, "entry is", "entries are")} flagged as a suspected artifact` : "",
    late > 0 ? `${plural(late, "entry", "entries")} arrived late` : "",
  ].filter(Boolean);
  return parts.length === 0 ? null : `${parts.join(" and ")} (flags stored by the capture app). The totals include them.`;
}

// --- energy and macronutrients, with the estimate ---

/** Kilocalories per gram (the Atwater general factors). An ESTIMATE of where energy came from, never a measurement. */
export const KCAL_PER_GRAM = { protein: 4, carbohydrates: 4, fat: 9 } as const;
export type Macro = keyof typeof KCAL_PER_GRAM;

/** The contract ids of the nutrients the table needs. They are contract ids, not codes or units. */
export const MACRO_IDS = { energy: "dietaryEnergy", protein: "dietaryProtein", carbohydrates: "dietaryCarbohydrates", fat: "dietaryFat" } as const;

export interface MacroRow {
  readonly day: string;
  readonly energy: number | null;
  readonly protein: number | null;
  readonly carbohydrates: number | null;
  readonly fat: number | null;
  /** Percent of the day's reported energy that the three macronutrients account for, by the factors above; null when it cannot be worked out. */
  readonly share: Record<Macro, number> | null;
}

const totalOf = (cell: DayCell | undefined): number | null => (cell && cell.kind === "entries" ? cell.total : null);

/**
 * One row per day for the energy and macronutrient table. A nutrient with no entries that day is `null` ("none"), and
 * the estimated shares exist only when the day has energy above 0 and all three macronutrients.
 */
export function macroRows(days: readonly string[], cells: Record<keyof typeof MACRO_IDS, readonly DayCell[]>): MacroRow[] {
  const at = (key: keyof typeof MACRO_IDS, i: number) => totalOf(cells[key][i]);
  return days.map((day, i) => {
    const energy = at("energy", i);
    const protein = at("protein", i);
    const carbohydrates = at("carbohydrates", i);
    const fat = at("fat", i);
    const share = energy !== null && energy > 0 && protein !== null && carbohydrates !== null && fat !== null
      ? {
        protein: Math.round((protein * KCAL_PER_GRAM.protein / energy) * 100),
        carbohydrates: Math.round((carbohydrates * KCAL_PER_GRAM.carbohydrates / energy) * 100),
        fat: Math.round((fat * KCAL_PER_GRAM.fat / energy) * 100),
      }
      : null;
    return { day, energy, protein, carbohydrates, fat, share };
  });
}
