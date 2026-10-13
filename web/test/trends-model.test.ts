import { describe, expect, it } from "vitest";
import {
  PRESETS, TrendShapeError, buildChartData, compareMetrics, daysBetween, missingRanges, parseBands, presetRange,
  summarize, todayUtc, validateRange, type BandsResponse,
} from "../src/trends/model.ts";
import { buildPlot, daySplits, tickLabel, withAlpha } from "../src/trends/plot.ts";

const completeness = (over: object = {}) => ({
  requestedDays: 5, daysWithData: 3, missingDays: ["2026-10-02", "2026-10-04"], pendingWindows: 0,
  lastComputedAt: "2026-10-05T10:00:00.000Z", workerWatermark: "2026-10-05T10:00:10.000Z", generatedAt: "2026-10-05T10:00:20.000Z", ...over,
});
const band = (day: string, n = 1440, min = 50, median = 65, max = 120) => ({ day, n, min, median, max, revision: 1 });
const raw = (over: object = {}) => ({
  patientId: "42",
  metric: { id: "heartRate", display: "Heart rate", unit: "/min" },
  from: "2026-10-01", to: "2026-10-05",
  dayDefinition: "UTC calendar day of the sample's instant",
  bands: [band("2026-10-01"), band("2026-10-03"), band("2026-10-05")],
  completeness: completeness(),
  ...over,
});

describe("parseBands", () => {
  it("accepts the documented shape and orders the days", () => {
    const r = parseBands(raw({ bands: [band("2026-10-05"), band("2026-10-01")] }));
    expect(r.bands.map((b) => b.day)).toEqual(["2026-10-01", "2026-10-05"]);
    expect(r.metric.unit).toBe("/min");
  });

  // each of these is a way the answer could be wrong; none may become a chart of "whatever was there"
  it.each([
    ["not an object", 7],
    ["no bands list", raw({ bands: undefined })],
    ["a band with a missing field", raw({ bands: [{ day: "2026-10-01", n: 3, min: 1, median: 2 }] })],
    ["a non-finite value", raw({ bands: [band("2026-10-01", 3, 1, Number.NaN, 3)] })],
    ["a band outside the requested range", raw({ bands: [band("2026-09-30")] })],
    ["min above median", raw({ bands: [band("2026-10-01", 3, 70, 65, 120)] })],
    ["median above max", raw({ bands: [band("2026-10-01", 3, 50, 130, 120)] })],
    ["a day twice", raw({ bands: [band("2026-10-01"), band("2026-10-01")] })],
    ["a day that is not a date", raw({ bands: [band("2026-13-45")] })],
    ["no completeness", raw({ completeness: undefined })],
    ["malformed completeness", raw({ completeness: completeness({ missingDays: "none" }) })],
  ])("rejects %s", (_name, body) => {
    expect(() => parseBands(body)).toThrow(TrendShapeError);
  });
});

describe("a day with no data is a gap, never a value", () => {
  const r = parseBands(raw()) as BandsResponse;
  const d = buildChartData(r);

  it("has one slot per requested day, null where the API has no row", () => {
    expect(d.days).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05"]);
    expect(d.median).toEqual([65, null, 65, null, 65]);
    expect(d.min).toEqual([50, null, 50, null, 50]);
    expect(d.max).toEqual([120, null, 120, null, 120]);
    expect(d.n).toEqual([1440, null, 1440, null, 1440]);
    expect(d.missing).toEqual(["2026-10-02", "2026-10-04"]);
  });

  it("x values are UTC midnights in seconds", () => {
    expect(d.x[0]).toBe(Date.UTC(2026, 9, 1) / 1000);
    expect(d.x[1]! - d.x[0]!).toBe(86_400);
  });

  it("marks the days a line cannot join: each is isolated between gaps", () => {
    expect(d.isolated).toEqual([0, 2, 4]);
  });

  it("does not mark days that have a neighbour", () => {
    const two = buildChartData(parseBands(raw({ bands: [band("2026-10-01"), band("2026-10-02"), band("2026-10-05")] })));
    expect(two.isolated).toEqual([4]);
  });

  it("is not 'points only' for a day with many samples, and is for one value a day", () => {
    expect(d.pointsOnly).toBe(false);
    const daily = buildChartData(parseBands(raw({ bands: [band("2026-10-01", 1, 60, 60, 60), band("2026-10-02", 1, 61, 61, 61)] })));
    expect(daily.pointsOnly).toBe(true);
    // positive control for the above: one day with two samples turns it off again
    const mixed = buildChartData(parseBands(raw({ bands: [band("2026-10-01", 1, 60, 60, 60), band("2026-10-02", 2, 60, 61, 62)] })));
    expect(mixed.pointsOnly).toBe(false);
  });

  it("an empty answer is all gaps and never 'points only'", () => {
    const e = buildChartData(parseBands(raw({ bands: [] })));
    expect(e.median.every((v) => v === null)).toBe(true);
    expect(e.missing).toHaveLength(5);
    expect(e.pointsOnly).toBe(false);
  });
});

describe("chart configuration", () => {
  const theme = { series: "#2a78d6", surface: "#fcfcfb", ink: "#0b0b0b", muted: "#898781", grid: "#e1e0d9" };
  const data = buildChartData(parseBands(raw()));

  it("passes the gaps through as null and never spans them", () => {
    const { data: aligned, options } = buildPlot(data, theme, "/min", "Heart rate");
    expect(aligned).toHaveLength(4); // x, max, median, min
    expect(aligned[2]).toEqual([65, null, 65, null, 65]);
    expect(options.series?.slice(1).every((s) => (s as { spanGaps?: boolean }).spanGaps === false)).toBe(true);
  });

  it("puts a marker on exactly the isolated days", () => {
    const { options } = buildPlot(data, theme, "/min", "Heart rate");
    const median = options.series![2] as { points?: { show?: boolean; filter?: number[] } };
    expect(median.points?.show).toBe(true);
    expect(median.points?.filter).toEqual([0, 2, 4]);
  });

  it("fills the range between the upper and lower series as a wash, and not for one value a day", () => {
    expect(buildPlot(data, theme, "/min", "Heart rate").options.bands).toEqual([{ series: [1, 3], fill: "rgba(42, 120, 214, 0.16)" }]);
    const daily = buildChartData(parseBands(raw({ bands: [band("2026-10-01", 1, 60, 60, 60)] })));
    expect(buildPlot(daily, theme, "/min", "Resting").options.bands).toEqual([]);
  });

  it("draws a daily value as points only: no line, a marker on every day with data", () => {
    const daily = buildChartData(parseBands(raw({ bands: [band("2026-10-01", 1, 60, 60, 60), band("2026-10-02", 1, 61, 61, 61), band("2026-10-05", 1, 62, 62, 62)] })));
    const { options } = buildPlot(daily, theme, "/min", "Resting heart rate");
    const median = options.series![2] as { width?: number; points?: { filter?: number[] } };
    expect(median.width).toBe(0);
    expect(median.points?.filter).toEqual([0, 1, 4]);
  });

  it("uses the theme's colours, never a hard-coded one, and has no legend box for a single series", () => {
    const { options } = buildPlot(data, { ...theme, series: "#1baf7a" }, "/min", "Heart rate");
    expect((options.series![2] as { stroke?: string }).stroke).toBe("#1baf7a");
    expect(options.legend).toEqual({ show: false });
  });

  it("withAlpha converts a hex colour and leaves anything else alone", () => {
    expect(withAlpha("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
    expect(withAlpha("var(--x)", 0.5)).toBe("var(--x)");
  });
});

describe("the time axis is in UTC", () => {
  const sec = (d: string) => Date.parse(`${d}T00:00:00Z`) / 1000;

  it("labels a UTC midnight as that UTC day, whatever the browser zone", () => {
    expect(tickLabel(sec("2026-10-06"))).toBe("Oct 06");
    expect(tickLabel(sec("2026-01-01"))).toBe("Jan 01");
    expect(tickLabel(sec("2026-12-31"))).toBe("Dec 31");
  });

  it("puts ticks only on UTC midnights", () => {
    for (const t of daySplits(sec("2026-09-13"), sec("2026-10-13"), 700)) expect(t % 86_400).toBe(0);
  });

  it("thins ticks as the range grows, keeping at least the minimum spacing", () => {
    const week = daySplits(sec("2026-10-07"), sec("2026-10-13"), 700);
    const year = daySplits(sec("2025-10-13"), sec("2026-10-13"), 700);
    expect(week.length).toBeGreaterThan(5); // daily labels fit
    expect(year.length).toBeLessThan(15);
    const gaps = year.slice(1).map((t, i) => (t - year[i]!) / 86_400);
    expect(new Set(gaps).size).toBe(1); // a regular step
    expect(700 / 365 * gaps[0]!).toBeGreaterThanOrEqual(64);
  });
});

describe("ranges", () => {
  it("a preset ends on the given day and spans exactly that many days", () => {
    for (const days of PRESETS) {
      const r = presetRange(days, "2026-10-13");
      expect(r.to).toBe("2026-10-13");
      expect(daysBetween(r.from, r.to)).toHaveLength(days);
    }
    expect(presetRange(7, "2026-10-13").from).toBe("2026-10-07");
  });

  it("today is the UTC date, not the local one", () => {
    expect(todayUtc(new Date("2026-10-13T23:30:00-07:00"))).toBe("2026-10-14");
  });

  it("validates a custom range in words", () => {
    expect(validateRange("2026-10-01", "2026-10-13")).toBeNull();
    expect(validateRange("2026-10-13", "2026-10-13")).toBeNull();
    expect(validateRange("2026-10-14", "2026-10-13")).toMatch(/after/);
    expect(validateRange("", "2026-10-13")).toMatch(/both dates/);
    expect(validateRange("2025-01-01", "2026-10-13")).toMatch(/at most 366/);
    expect(validateRange("2025-10-13", "2026-10-13")).toBeNull(); // 366 days inclusive is the limit
  });
});

describe("words for a screen reader", () => {
  const info = { id: "heartRate", display: "Heart rate", unit: "/min" };

  it("states the extent, the extremes, and the gaps as gaps", () => {
    const text = summarize(info, buildChartData(parseBands(raw())), "2026-10-01", "2026-10-05");
    expect(text).toContain("3 of 5 days with data");
    expect(text).toContain("lowest of 50 to a highest of 120");
    expect(text).toContain("2026-10-02, 2026-10-04");
    expect(text).toMatch(/gaps, not estimated/);
  });

  it("says so when there is no data at all", () => {
    const text = summarize(info, buildChartData(parseBands(raw({ bands: [] }))), "2026-10-01", "2026-10-05");
    expect(text).toMatch(/no data in 5 days/);
  });

  it("collapses consecutive missing days into ranges", () => {
    expect(missingRanges(["2026-09-20", "2026-09-21", "2026-09-22", "2026-10-02"])).toEqual(["2026-09-20 to 2026-09-22", "2026-10-02"]);
    expect(missingRanges([])).toEqual([]);
  });
});

describe("the analytic service's metrics against the contract", () => {
  const contract = [{ id: "heartRate", unit: "/min" }, { id: "hrvSdnn", unit: "ms" }];
  const api = [{ id: "heartRate", display: "Heart rate", unit: "/min" }, { id: "hrvSdnn", display: "HRV", unit: "ms" }];

  it("agrees when the ids and units match", () => {
    expect(compareMetrics(api, contract)).toEqual([]);
  });

  it("names a changed unit, a missing metric and an unknown metric", () => {
    expect(compareMetrics([{ ...api[0]!, unit: "bpm" }, api[1]!], contract)[0]!.problem).toMatch(/unit bpm/);
    expect(compareMetrics([api[0]!], contract)[0]).toMatchObject({ id: "hrvSdnn" });
    expect(compareMetrics([...api, { id: "steps", display: "Steps", unit: "{count}" }], contract)).toEqual([
      { id: "steps", problem: expect.stringMatching(/does not know/) },
    ]);
  });
});
