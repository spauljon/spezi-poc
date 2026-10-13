import { describe, expect, it, vi } from "vitest";
import { buildDay, dayStart, noSkips, type Sample } from "../src/intraday/model.ts";
import {
  buildIntradayPlot, paintFlagged, paintGaps, timeLabel, timeSplits, withGapBreaks, type PaintTarget,
} from "../src/intraday/plot.ts";
import { clampView, isWholeDay, pan, revealing, zoomHours } from "../src/intraday/view.ts";
import { contract } from "./support.ts";

const DAY = "2026-09-25";
const t0 = dayStart(DAY);
const at = (h: number, m = 0) => t0 + (h * 60 + m) * 60_000;
const s = (ms: number, v = 66, flags: string[] = []): Sample => ({ id: String(ms), t: ms, v, flags });
const theme = { series: "#2a78d6", surface: "#fcfcfb", ink: "#0b0b0b", muted: "#898781", grid: "#e1e0d9" };
const FAR = new Date("2030-01-01T00:00:00Z");

describe("time axis (UTC)", () => {
  const sec = (ms: number) => ms / 1000;

  it("labels a UTC instant as its clock time", () => {
    expect(timeLabel(sec(at(14, 30)))).toBe("14:30");
    expect(timeLabel(sec(at(0)))).toBe("00:00");
  });

  it("ticks only on clock boundaries and thins as the window widens", () => {
    const day = timeSplits(sec(at(0)), sec(at(24)), 800);
    const hour = timeSplits(sec(at(10)), sec(at(11)), 800);
    for (const t of [...day, ...hour]) expect(t % 60).toBe(0);
    expect(day.every((t) => t % 3600 === 0)).toBe(true); // hours (or longer) across a day
    const spacing = (a: number[]) => a.slice(1).map((t, i) => t - a[i]!);
    expect(new Set(spacing(day)).size).toBe(1); // a regular step
    expect(spacing(hour)[0]!).toBeLessThan(spacing(day)[0]!); // finer when zoomed in
    expect(800 / 86_400 * spacing(day)[0]!).toBeGreaterThanOrEqual(72); // never closer than a label needs
    expect(800 / 3_600 * spacing(hour)[0]!).toBeGreaterThanOrEqual(72);
  });
});

describe("line breaks in gaps", () => {
  const model = buildDay(DAY, [s(at(1)), s(at(1, 1)), s(at(5)), s(at(5, 1))], noSkips(), FAR);

  it("puts a null point in each gap so the line stops, and nowhere else (plus the two anchors)", () => {
    const p = withGapBreaks(model);
    // [start anchor, 66, 66, break, 66, 66, end anchor]
    expect(p.y).toEqual([null, 66, 66, null, 66, 66, null]);
    expect(p.x[3]).toBe((at(1, 1) + at(5)) / 2000);
    expect(p.sample).toEqual([-1, 0, 1, -1, 2, 3, -1]);
  });

  it("anchors the data at both ends of the day, so 'full day' is the day and not first-to-last sample", () => {
    const p = withGapBreaks(model);
    expect(p.x[0]).toBe(model.windowStart / 1000);
    expect(p.x[p.x.length - 1]).toBe(model.windowEnd / 1000);
    // a day that already starts at midnight needs no start anchor (control)
    const full = buildDay(DAY, [s(t0), s(t0 + 1000)], noSkips(), new Date(t0 + 1000));
    const q = withGapBreaks(full);
    expect(q.x[0]).toBe(t0 / 1000);
    expect(q.y[0]).toBe(66);
    expect(q.x.filter((v) => v === t0 / 1000)).toHaveLength(1);
  });

  it("adds no break for a day without a gap (control)", () => {
    const m = buildDay(DAY, [s(at(0)), s(at(0, 1)), s(at(0, 2))], noSkips(), new Date(at(0, 2)));
    expect(withGapBreaks(m).y).toEqual([66, 66, 66]);
  });

  it("never spans gaps and draws the window of the day", () => {
    const { options, data, sample } = buildIntradayPlot(model, theme, "/min", "Heart rate", "k");
    expect((options.series![1] as { spanGaps?: boolean }).spanGaps).toBe(false);
    expect(data[1]).toEqual([null, 66, 66, null, 66, 66, null]);
    expect(sample).toEqual([-1, 0, 1, -1, 2, 3, -1]);
    // an ordinary automatic scale, so a zoom stands: a static range array (or a range function that ignores its
    // inputs) is returned for every zoom request and undoes it (found in a real browser, see README T-notes)
    expect(options.scales!["x"]!.range).toBeUndefined();
    expect(options.cursor?.sync?.key).toBe("k");
  });
});

describe("overlays", () => {
  /** A canvas stand-in that records what is drawn; the x axis maps 1 s to 1 px and y maps value to value. */
  function target() {
    const calls: Array<[string, ...unknown[]]> = [];
    const rec = (name: string) => vi.fn((...a: unknown[]) => { calls.push([name, ...a]); });
    const ctx = {
      save: rec("save"), restore: rec("restore"), beginPath: rec("beginPath"), rect: rec("rect"), clip: rec("clip"),
      fillRect: rec("fillRect"), moveTo: rec("moveTo"), lineTo: rec("lineTo"), closePath: rec("closePath"), fill: rec("fill"), stroke: rec("stroke"),
      fillStyle: "", strokeStyle: "", lineWidth: 0,
    };
    const u: PaintTarget = { ctx, bbox: { left: 0, top: 10, width: 86_400, height: 100 }, valToPos: (v, scale) => (scale === "x" ? v - t0 / 1000 : 200 - v) };
    return { u, calls };
  }

  it("shades each gap from its start to its end, within the plot", () => {
    const model = buildDay(DAY, [s(at(1)), s(at(1, 1)), s(at(5)), s(at(5, 1))], noSkips(), FAR);
    const { u, calls } = target();
    paintGaps(u, model, theme);
    const rects = calls.filter((c) => c[0] === "fillRect");
    // between 01:01 and 05:00, plus the start-of-day gap (00:00-01:00) and the end-of-day gap (05:01-24:00)
    expect(rects).toHaveLength(model.gaps.length);
    const between = model.gaps.findIndex((g) => g.edge === null);
    expect(rects[between]![1]).toBe((at(1, 1) - t0) / 1000);
    expect(rects[between]![3]).toBe((at(5) - at(1, 1)) / 1000);
    expect(calls.some((c) => c[0] === "clip")).toBe(true);
  });

  it("draws a diamond on exactly the flagged samples, and none without flags (control)", () => {
    const flag = contract.dataQualityFlag.artifactSuspected;
    const model = buildDay(DAY, [s(at(1), 60), s(at(2), 250, [flag]), s(at(3), 240), s(at(4), 280, [flag])], noSkips(), FAR);
    const { u, calls } = target();
    paintFlagged(u, model, theme, 2);
    expect(calls.filter((c) => c[0] === "stroke")).toHaveLength(2);
    expect(calls.filter((c) => c[0] === "moveTo").map((c) => c[2])).toEqual([200 - 250 - 14, 200 - 280 - 14]); // top vertex, r = 7 x ratio

    const clean = buildDay(DAY, [s(at(1), 60), s(at(2), 240)], noSkips(), FAR);
    const none = target();
    paintFlagged(none.u, clean, theme);
    expect(none.calls.filter((c) => c[0] === "stroke")).toHaveLength(0);
  });
});

describe("the visible window", () => {
  const day = { start: 1000, end: 1000 + 86_400 };

  it("zooms to a width of hours around the centre and stays in the day", () => {
    expect(zoomHours(6, null, day)).toEqual({ min: 1000 + 43_200 - 10_800, max: 1000 + 43_200 + 10_800 });
    const nearEnd = zoomHours(1, { min: day.end - 600, max: day.end }, day);
    expect(nearEnd.max).toBe(day.end);
    expect(nearEnd.max - nearEnd.min).toBe(3600);
  });

  it("pans by half a window and stops at the edges; the whole day does not pan", () => {
    const v = { min: 1000 + 3600, max: 1000 + 7200 };
    expect(pan(v, 1, day)).toEqual({ min: 1000 + 5400, max: 1000 + 9000 });
    expect(pan({ min: 1000, max: 1000 + 3600 }, -1, day)).toEqual({ min: 1000, max: 1000 + 3600 });
    expect(pan(null, 1, day)).toBeNull();
  });

  it("knows the whole day, and reveals a time only when it is out of view", () => {
    expect(isWholeDay(null, day)).toBe(true);
    expect(isWholeDay({ min: day.start, max: day.end }, day)).toBe(true);
    expect(isWholeDay({ min: day.start, max: day.end - 10 }, day)).toBe(false);
    const v = { min: 1000, max: 1000 + 3600 };
    expect(revealing(v, 1000 + 100, day)).toBe(v);
    expect(revealing(v, 1000 + 40_000, day)).toEqual(clampView({ min: 1000 + 40_000 - 1800, max: 1000 + 40_000 + 1800 }, day));
  });
});
