import type { Completeness, MetricInfo } from "../trends/model.ts";

/** One meal's share of a day: a contract meal code, or `unlabelled` for entries that carry none. */
export interface MealTotal {
  readonly meal: string;
  readonly total: number;
  readonly entries: number;
}

/** A day that has entries. A day with none is not in the list at all: it is in `completeness.missingDays`. */
export interface IntakeDay {
  readonly day: string;
  readonly total: number;
  readonly entries: number;
  readonly firstEntry: string;
  readonly lastEntry: string;
  readonly artifactSuspected: number;
  readonly lateArrival: number;
  readonly revision: number;
  readonly byMeal: readonly MealTotal[];
}

export interface NutritionResponse {
  readonly patientId: string;
  readonly nutrient: MetricInfo;
  readonly from: string;
  readonly to: string;
  readonly dayDefinition: string;
  readonly days: readonly IntakeDay[];
  readonly completeness: Completeness;
}

export class NutritionShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NutritionShapeError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isInstant = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const amount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const count = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

/** The meal rows are sums of exact micro-units, so they add up to the day to well inside this per entry. */
const SUM_TOLERANCE_PER_ENTRY = 1e-6;

/**
 * Validates the documented answer rather than casting it: a response of another shape, or one that contradicts
 * itself (meals that do not add up to the day, a day both present and listed as missing), is an error the user is
 * told about, never a chart of whatever happened to be there.
 */
export function parseNutrition(raw: unknown): NutritionResponse {
  if (!isRecord(raw)) throw new NutritionShapeError("The response is not an object.");
  const { patientId, nutrient, from, to, dayDefinition, days, completeness } = raw;
  if (typeof patientId !== "string") throw new NutritionShapeError("patientId is missing.");
  if (!isRecord(nutrient) || typeof nutrient["id"] !== "string" || typeof nutrient["display"] !== "string" || typeof nutrient["unit"] !== "string") {
    throw new NutritionShapeError("nutrient is malformed.");
  }
  if (!isDay(from) || !isDay(to)) throw new NutritionShapeError("from/to are not dates.");
  if (typeof dayDefinition !== "string") throw new NutritionShapeError("dayDefinition is missing.");
  if (!Array.isArray(days)) throw new NutritionShapeError("days is not a list.");
  if (!isRecord(completeness)) throw new NutritionShapeError("completeness is missing.");

  const parsed: IntakeDay[] = days.map((item: unknown) => {
    if (!isRecord(item)) throw new NutritionShapeError("a day is malformed.");
    const { day, total, entries, firstEntry, lastEntry, artifactSuspected, lateArrival, revision, byMeal } = item;
    if (!isDay(day) || !amount(total) || !count(entries) || entries < 1 || !isInstant(firstEntry) || !isInstant(lastEntry) || !count(revision)) {
      throw new NutritionShapeError("a day is malformed.");
    }
    if (!count(artifactSuspected) || !count(lateArrival) || artifactSuspected > entries || lateArrival > entries) {
      throw new NutritionShapeError("a day's flag counts are missing, not whole numbers, or larger than its entries.");
    }
    if (day < from || day > to) throw new NutritionShapeError("a day lies outside the requested range.");
    if (!Array.isArray(byMeal) || byMeal.length === 0) throw new NutritionShapeError("a day has no meal split.");
    const meals: MealTotal[] = byMeal.map((m: unknown) => {
      if (!isRecord(m) || typeof m["meal"] !== "string" || !amount(m["total"]) || !count(m["entries"]) || m["entries"] < 1) {
        throw new NutritionShapeError("a meal row is malformed.");
      }
      return { meal: m["meal"], total: m["total"], entries: m["entries"] };
    });
    if (new Set(meals.map((m) => m.meal)).size !== meals.length) throw new NutritionShapeError("a meal appears twice in a day.");
    const mealTotal = meals.reduce((t, m) => t + m.total, 0);
    if (Math.abs(mealTotal - total) > SUM_TOLERANCE_PER_ENTRY * entries || meals.reduce((n, m) => n + m.entries, 0) !== entries) {
      throw new NutritionShapeError("a day's meals do not add up to the day.");
    }
    return { day, total, entries, firstEntry, lastEntry, artifactSuspected, lateArrival, revision, byMeal: meals };
  });
  const dayList = parsed.map((d) => d.day);
  if (new Set(dayList).size !== dayList.length) throw new NutritionShapeError("a day appears twice.");

  const c = completeness;
  const missing = c["missingDays"];
  if (!count(c["requestedDays"]) || !count(c["daysWithData"]) || !count(c["pendingWindows"]) || !Array.isArray(missing) || !missing.every(isDay)) {
    throw new NutritionShapeError("completeness is malformed.");
  }
  if (missing.some((d) => dayList.includes(d))) throw new NutritionShapeError("a day is both present and listed as having no entries.");
  return {
    patientId,
    nutrient: { id: nutrient["id"], display: nutrient["display"], unit: nutrient["unit"] },
    from, to, dayDefinition,
    days: parsed.sort((a, b) => (a.day < b.day ? -1 : 1)),
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
