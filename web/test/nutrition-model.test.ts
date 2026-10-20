import { describe, expect, it } from "vitest";
import { parseContract } from "../src/contract.ts";
import { NutritionShapeError, parseNutrition } from "../src/nutrition/api.ts";
import {
  KCAL_PER_GRAM, MACRO_IDS, UNLABELLED, buildCells, flagsNotice, macroRows, mealKeys, niceScale, readoutText, summaryText,
  type DayCell,
} from "../src/nutrition/model.ts";
import { nutritionHref, parseHash } from "../src/route.ts";
import rawContract from "../../contract/metrics.json";
import { contract } from "./support.ts";

const day = (d: string, byMeal: Array<[string, number, number]>, extra: Partial<{ artifactSuspected: number; lateArrival: number }> = {}) => ({
  day: d,
  total: byMeal.reduce((t, m) => t + m[1], 0),
  entries: byMeal.reduce((n, m) => n + m[2], 0),
  firstEntry: `${d}T08:00:00.000Z`, lastEntry: `${d}T20:00:00.000Z`,
  artifactSuspected: 0, lateArrival: 0, revision: 1,
  byMeal: byMeal.map(([meal, total, entries]) => ({ meal, total, entries })),
  ...extra,
});
const response = (days: unknown[], over: Record<string, unknown> = {}) => ({
  patientId: "42", nutrient: { id: "dietaryEnergy", display: "Calorie intake total", unit: "kcal" },
  from: "2026-10-01", to: "2026-10-05", dayDefinition: "day as recorded",
  days,
  completeness: { requestedDays: 5, daysWithData: days.length, missingDays: [], pendingWindows: 0, lastComputedAt: null, workerWatermark: null, generatedAt: "" },
  ...over,
});

describe("the contract, as this app reads it", () => {
  it("lists every intake metric with a short label from its id, its unit and the contract's own display", () => {
    const raw = (rawContract as { metrics: { id: string; kind: string; unit: { ucum: string } }[] }).metrics.filter((m) => m.kind === "intake");
    expect(contract.intakeMetrics.map((m) => [m.id, m.unit])).toEqual(raw.map((m) => [m.id, m.unit.ucum]));
    expect(contract.intakeMetrics.length).toBeGreaterThanOrEqual(8);
    expect(contract.intakeMetrics.find((m) => m.id === "dietaryEnergy")!.label).toBe("Energy");
    expect(contract.intakeMetrics.find((m) => m.id === "dietaryFiber")!.display).toBe("Dietary fiber"); // a custom code's display
    expect(contract.intakeMetrics.find((m) => m.id === "dietaryEnergy")!.display).toBe("Calorie intake total"); // a LOINC display
    expect(contract.mealTypes.map((m) => m.code)).toEqual(["breakfast", "lunch", "dinner", "snack", "other"]);
  });

  it("an older contract simply has no intake metrics (the view says so rather than breaking)", () => {
    const old = { ...(rawContract as object), contractVersion: "1.4.0", metrics: (rawContract as { metrics: { kind: string }[] }).metrics.filter((m) => m.kind !== "intake"), mealTypes: undefined };
    const c = parseContract(old);
    expect(c.intakeMetrics).toEqual([]);
    expect(c.mealTypes).toEqual([]);
  });

  it("the ids the macronutrient table needs exist in the contract", () => {
    for (const id of Object.values(MACRO_IDS)) expect(contract.intakeMetrics.some((m) => m.id === id), id).toBe(true);
  });
});

describe("route", () => {
  it("round-trips the nutrition view and its nutrient, and ignores a nutrient that is not a plain id", () => {
    expect(parseHash("#/nutrition")).toEqual({ view: "nutrition", nutrient: null });
    expect(parseHash(nutritionHref("dietaryFat"))).toEqual({ view: "nutrition", nutrient: "dietaryFat" });
    expect(nutritionHref()).toBe("#/nutrition");
    expect(parseHash("#/nutrition?nutrient=../x")).toEqual({ view: "nutrition", nutrient: null });
    expect(parseHash("#/nutrition?nutrient=a%20b")).toEqual({ view: "nutrition", nutrient: null });
    expect(parseHash("#/sleep").view).toBe("sleep"); // control: other views still parse
  });
});

describe("parseNutrition", () => {
  const good = response([day("2026-10-02", [["breakfast", 400, 1], [UNLABELLED, 150.5, 2]]), day("2026-10-04", [[UNLABELLED, 0, 1]])]);

  it("accepts the documented shape, sorts the days, and keeps a total of 0", () => {
    const parsed = parseNutrition({ ...good, days: [...good.days].reverse() });
    expect(parsed.days.map((d) => [d.day, d.total, d.entries])).toEqual([["2026-10-02", 550.5, 3], ["2026-10-04", 0, 1]]);
  });

  it.each([
    ["not an object", "x", /not an object/],
    ["no patient", { ...good, patientId: 1 }, /patientId/],
    ["a malformed nutrient", { ...good, nutrient: { id: "x" } }, /nutrient/],
    ["a bad date", { ...good, from: "yesterday" }, /dates/],
    ["days not a list", { ...good, days: {} }, /not a list/],
    ["a negative total", response([{ ...day("2026-10-02", [["lunch", 1, 1]]), total: -1 }]), /malformed/],
    ["a day with no entries", response([{ ...day("2026-10-02", [["lunch", 1, 1]]), entries: 0 }]), /malformed/],
    ["a day outside the range", response([day("2026-11-02", [["lunch", 1, 1]])]), /outside/],
    ["flags above the entries", response([day("2026-10-02", [["lunch", 1, 1]], { artifactSuspected: 2 })]), /flag counts/],
    ["meals that do not add up to the day", response([{ ...day("2026-10-02", [["lunch", 100, 1]]), total: 99 }]), /do not add up/],
    ["meal entries that do not add up", response([{ ...day("2026-10-02", [["lunch", 100, 1]]), entries: 2 }]), /do not add up/],
    ["a meal twice", response([day("2026-10-02", [["lunch", 1, 1], ["lunch", 1, 1]])]), /twice/],
    ["a day twice", response([day("2026-10-02", [["lunch", 1, 1]]), day("2026-10-02", [["lunch", 1, 1]])]), /twice/],
    ["a day both present and missing", response([day("2026-10-02", [["lunch", 1, 1]])], { completeness: { requestedDays: 5, daysWithData: 1, missingDays: ["2026-10-02"], pendingWindows: 0 } }), /both present/],
    ["no meal split", response([{ ...day("2026-10-02", [["lunch", 1, 1]]), byMeal: [] }]), /meal split/],
  ])("refuses %s", (_n, body, why) => {
    expect(() => parseNutrition(body)).toThrow(NutritionShapeError);
    expect(() => parseNutrition(body)).toThrow(why);
    expect(() => parseNutrition(good)).not.toThrow(); // the control: the same shape, repaired, is accepted
  });
});

describe("cells", () => {
  const parsed = parseNutrition(response([day("2026-10-02", [["breakfast", 400, 1], ["lunch", 600, 1]]), day("2026-10-04", [[UNLABELLED, 0, 2]])]));
  const cells = buildCells(parsed);

  it("one cell per requested day; a day with no entries is 'none', never a zero, and a zero total is a day with entries", () => {
    expect(cells.map((c) => c.day)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(cells.map((c) => c.kind)).toEqual(["none", "entries", "none", "entries", "none"]);
    const zero = cells[3]!;
    expect(zero.kind === "entries" && zero.total).toBe(0);
    expect(cells[0]).toEqual({ kind: "none", day: "2026-10-01" });
  });

  it("the meal buckets are in the contract's order, unlabelled last, and only those present", () => {
    expect(mealKeys(cells, ["breakfast", "lunch", "dinner"])).toEqual(["breakfast", "lunch", UNLABELLED]);
    expect(mealKeys(cells, ["lunch", "breakfast"])).toEqual(["lunch", "breakfast", UNLABELLED]);
    expect(mealKeys([], ["breakfast"])).toEqual([]);
  });

  it("the summary counts days with entries, states the range and the average of those days only, and says what empty slots mean", () => {
    const text = summaryText("Energy", "kcal", cells);
    expect(text).toContain("2 of 5 days have entries");
    expect(text).toContain("from 0 to 1000 kcal");
    expect(text).toContain("averaging 500 kcal per day with entries");
    expect(text).toContain("the highest was 2026-10-02");
    expect(text).toContain("1 day sums to 0");
    expect(text).toContain("3 days have no entries");
    expect(text).toContain("not counted as 0");
  });

  it("a range with no entries at all says so, and does not say 0", () => {
    const text = summaryText("Energy", "kcal", cells.map((c) => ({ kind: "none", day: c.day }) as DayCell));
    expect(text).toContain("no entries on any of these 5 days");
    expect(text).not.toMatch(/averag|ranged/);
  });

  it("the readout: a day with entries (with its meals), a total of 0, and a day with none", () => {
    const meal = (m: string) => (m === UNLABELLED ? "No meal recorded" : m);
    expect(readoutText(cells[1]!, "Energy", "kcal", meal)).toBe("2026-10-02: Energy 1000 kcal from 2 entries; breakfast 400, lunch 600.");
    expect(readoutText(cells[3]!, "Energy", "kcal", meal)).toBe("2026-10-04: Energy 0 kcal from 2 entries.");
    expect(readoutText(cells[0]!, "Energy", "kcal", meal)).toBe("2026-10-01: no entries (nothing recorded, not a total of 0).");
  });

  it("flags: summed over the range and worded, and none stored is no sentence at all", () => {
    expect(flagsNotice(cells)).toBeNull();
    const flagged = buildCells(parseNutrition(response([
      day("2026-10-02", [["lunch", 9000, 3]], { artifactSuspected: 1 }), day("2026-10-03", [["lunch", 5, 2]], { artifactSuspected: 1, lateArrival: 2 }),
    ])));
    const text = flagsNotice(flagged)!;
    expect(text).toContain("2 entries are flagged as a suspected artifact");
    expect(text).toContain("2 entries arrived late");
    expect(text).toContain("The totals include them");
    expect(flagsNotice(buildCells(parseNutrition(response([day("2026-10-02", [["lunch", 1, 1]], { artifactSuspected: 1 })]))))).toContain("1 entry is flagged");
  });
});

describe("niceScale", () => {
  it.each([
    [0, 1], [-5, 1], [Number.NaN, 1], [0.7, 0.8], [3, 3], [42, 60], [1234, 1500], [2650, 3000], [100, 100],
  ])("a maximum of %s ends on %s", (max, top) => {
    const s = niceScale(max);
    expect(s.max).toBe(top);
    expect(s.max).toBeGreaterThanOrEqual(Number.isFinite(max) ? Math.max(max, 0) : 0);
    expect(s.ticks[0]).toBe(0);
    expect(s.ticks.at(-1)).toBe(s.max);
  });
  it("has a handful of gridlines, evenly spaced", () => {
    for (const max of [3, 77, 910, 2650, 6000, 25000]) {
      const t = niceScale(max).ticks;
      expect(t.length).toBeGreaterThanOrEqual(3);
      expect(t.length).toBeLessThanOrEqual(8);
      const steps = new Set(t.slice(1).map((v, i) => Math.round((v - t[i]!) * 1e6)));
      expect(steps.size).toBe(1);
    }
  });
});

describe("the energy and macronutrient rows, with the estimate", () => {
  const days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"];
  const cell = (d: string, total: number | null): DayCell => total === null ? { kind: "none", day: d } : {
    kind: "entries", day: d, total, entries: 1, firstEntry: "", lastEntry: "", artifactSuspected: 0, lateArrival: 0, byMeal: [],
  };
  const series = (values: Array<number | null>) => days.map((d, i) => cell(d, values[i]!));

  it("the shares are grams times the factor over reported energy (4, 4, 9 kcal per gram)", () => {
    expect(KCAL_PER_GRAM).toEqual({ protein: 4, carbohydrates: 4, fat: 9 });
    const rows = macroRows(days, {
      energy: series([2000, null, 0, 1800]), protein: series([100, null, 5, 90]),
      carbohydrates: series([250, 10, 5, null]), fat: series([70, null, 5, 60]),
    });
    expect(rows[0]!.share).toEqual({ protein: 20, carbohydrates: 50, fat: 32 }); // 400/2000, 1000/2000, 630/2000
    expect(rows[1]).toMatchObject({ energy: null, protein: null, carbohydrates: 10, share: null });
    expect(rows[2]!.share).toBeNull(); // energy of 0: no division, no estimate
    expect(rows[3]!.share).toBeNull(); // carbohydrates have no entries that day
    expect(rows.map((r) => r.day)).toEqual(days);
  });
});
