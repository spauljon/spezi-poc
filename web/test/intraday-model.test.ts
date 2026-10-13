import { describe, expect, it } from "vitest";
import type { Observation } from "../src/fhir/types.ts";
import {
  GAP_FACTOR, MIN_GAP_MS, buildDay, dayStart, noSkips, summarize, toSample, type Sample,
} from "../src/intraday/model.ts";
import { contract, metric, obs } from "./support.ts";

const hr = metric("heartRate");
const DAY = "2026-09-25";
const at = (h: number, m = 0, s = 0) => dayStart(DAY) + ((h * 60 + m) * 60 + s) * 1000;
const sample = (ms: number, v = 66, flags: string[] = [], id = String(ms)): Sample => ({ id, t: ms, v, flags });
const iso = (ms: number) => new Date(ms).toISOString();
const flag = contract.dataQualityFlag;
const FAR_FUTURE = new Date("2030-01-01T00:00:00Z");

describe("toSample", () => {
  const base = (over: Partial<Observation> = {}): Observation => ({ ...obs("heartRate", 72, iso(at(3)), iso(at(3))), id: "7", ...over });

  it("reads an instant, its value and its stored flags", () => {
    const o = base({ meta: { tag: [{ system: flag.system, code: flag.artifactSuspected }] } });
    expect(toSample(o, hr, contract)).toEqual({ id: "7", t: at(3), v: 72, flags: [flag.artifactSuspected] });
  });

  it("measures a period at its start", () => {
    const o: Observation = { ...base(), effectivePeriod: { start: iso(at(4)), end: iso(at(5)) } };
    delete o.effectiveDateTime;
    expect((toSample(o, hr, contract) as Sample).t).toBe(at(4));
  });

  it("takes only flags in the contract's flag system: the same code elsewhere, or another tag, is not a flag", () => {
    const o = base({ meta: { tag: [
      { system: "http://example.org/other", code: flag.artifactSuspected },
      { system: "http://terminology.hl7.org/CodeSystem/v3-ObservationValue", code: "SUBSETTED" },
    ] } });
    expect((toSample(o, hr, contract) as Sample).flags).toEqual([]);
    // positive control: the same code in the right system IS read
    const p = base({ meta: { tag: [{ system: flag.system, code: flag.artifactSuspected }] } });
    expect((toSample(p, hr, contract) as Sample).flags).toEqual([flag.artifactSuspected]);
  });

  it.each([
    ["a retracted Observation", { status: "entered-in-error" }, "retracted"],
    ["no time", { effectiveDateTime: "not a date" }, "noInstant"],
    ["no value", { valueQuantity: {} }, "noValue"],
    ["another unit", { valueQuantity: { value: 72, unit: "bpm", code: "bpm" } }, "unitDiffers"],
    ["no unit at all", { valueQuantity: { value: 72 } }, "unitDiffers"],
  ] as const)("leaves out %s and says why", (_n, over, reason) => {
    expect(toSample(base(over as Partial<Observation>), hr, contract)).toBe(reason);
  });
});

describe("buildDay", () => {
  it("sorts, drops what is outside the day and repeats of the same Observation", () => {
    const m = buildDay(DAY, [
      sample(at(2), 70, [], "b"), sample(at(1), 60, [], "a"), sample(at(1), 60, [], "a"), // a twice
      sample(dayStart(DAY) - 1, 99, [], "before"), sample(dayStart(DAY) + 86_400_000, 99, [], "after"),
    ], noSkips(), FAR_FUTURE);
    expect(m.t).toEqual([at(1), at(2)]);
    expect(m.v).toEqual([60, 70]);
    expect([m.min, m.median, m.max]).toEqual([60, 65, 70]);
  });

  describe("gaps", () => {
    const every = (stepS: number, fromMs: number, toMs: number) => {
      const out: Sample[] = [];
      for (let t = fromMs; t < toMs; t += stepS * 1000) out.push(sample(t));
      return out;
    };

    it("is an interval longer than 10 minutes at a 5 s cadence; the threshold is the floor", () => {
      const s = [...every(5, at(0), at(2)), ...every(5, at(2, 11), at(24))]; // 2h00 -> 2h11 missing = 11 min + 5 s
      const m = buildDay(DAY, s, noSkips(), FAR_FUTURE);
      expect(m.gapThresholdMs).toBe(MIN_GAP_MS);
      expect(m.gaps).toHaveLength(1);
      expect(m.gaps[0]).toMatchObject({ edge: null, start: at(2) - 5000, end: at(2, 11) });
    });

    it("is not a gap just under the threshold (control for the one above)", () => {
      const s = [...every(5, at(0), at(2)), ...every(5, at(2, 9, 50), at(24))]; // 9 min 55 s between samples
      expect(buildDay(DAY, s, noSkips(), FAR_FUTURE).gaps).toHaveLength(0);
    });

    it("scales with a sparse cadence: 30-minute samples need a ten-times-longer pause", () => {
      const s = every(1800, at(0), at(24)).filter((x) => x.t !== at(3) && x.t !== at(3, 30)); // 1.5 h pause: not a gap
      const m = buildDay(DAY, s, noSkips(), FAR_FUTURE);
      expect(m.medianIntervalMs).toBe(1_800_000);
      expect(m.gapThresholdMs).toBe(GAP_FACTOR * 1_800_000);
      expect(m.gaps).toHaveLength(0);
    });

    it("marks the start and the end of the day when samples begin late or stop early", () => {
      const s = every(5, at(2), at(20));
      const m = buildDay(DAY, s, noSkips(), FAR_FUTURE);
      expect(m.gaps.map((g) => g.edge)).toEqual(["start", "end"]);
      expect(m.gaps[0]).toMatchObject({ start: at(0), end: at(2) });
      expect(m.gaps[1]!.end).toBe(dayStart(DAY) + 86_400_000);
    });

    it("an unfinished day has no trailing gap: the window ends at 'now'", () => {
      const s = every(5, at(0), at(10));
      const m = buildDay(DAY, s, noSkips(), new Date(at(10)));
      expect(m.windowEnd).toBe(at(10));
      expect(m.gaps).toHaveLength(0);
    });
  });

  it("flags only samples that carry a stored flag, and reads no value as an artifact", () => {
    const m = buildDay(DAY, [
      sample(at(1), 66), sample(at(2), 250, [flag.artifactSuspected]), sample(at(3), 240) /* implausible, unflagged */,
    ], noSkips(), FAR_FUTURE);
    expect(m.flagged).toEqual([1]);
    expect(m.flagCodes[2]).toEqual([]);
  });

  it("summarises by the hour in UTC, with the flagged count", () => {
    const m = buildDay(DAY, [sample(at(1, 5), 60), sample(at(1, 50), 80, [flag.artifactSuspected]), sample(at(23, 59), 70)], noSkips(), FAR_FUTURE);
    expect(m.hourly).toHaveLength(24);
    expect(m.hourly[1]).toMatchObject({ n: 2, min: 60, median: 70, max: 80, flagged: 1 });
    expect(m.hourly[23]).toMatchObject({ n: 1, min: 70 });
    expect(m.hourly[0]).toMatchObject({ n: 0, min: null, median: null });
  });
});

describe("the words", () => {
  const model = (samples: Sample[], skipped = noSkips()) => buildDay(DAY, samples, skipped, FAR_FUTURE);

  it("states the count, extremes and whether the extreme is flagged", () => {
    const flaggedHigh = summarize(model([sample(at(1), 60), sample(at(2), 280, [flag.artifactSuspected])]), "Heart rate", "/min");
    expect(flaggedHigh).toContain("highest 280 /min at 02:00 UTC (flagged)");
    const unflaggedHigh = summarize(model([sample(at(1), 60), sample(at(2), 280)]), "Heart rate", "/min");
    expect(unflaggedHigh).toContain("highest 280 /min at 02:00 UTC (not flagged)");
  });

  it("says when nothing is flagged, and lists the gaps", () => {
    // one sample a minute for the first hour and the last hour: a 22 h 59 min pause between them
    const s: Sample[] = [];
    for (let m = 0; m < 60; m++) s.push(sample(at(0, m), 60 + (m % 5)));
    for (let m = 0; m < 60; m++) s.push(sample(at(23, m), 70));
    const text = summarize(model(s), "Heart rate", "/min");
    expect(text).toContain("No sample carries a stored data-quality flag.");
    expect(text).toMatch(/1 gap of 10 min or more: 00:59 to 23:00 UTC, 22 h 1 min\./);
  });

  it("states what was left out", () => {
    const text = summarize(model([sample(at(1), 60)], { noInstant: 0, noValue: 2, unitDiffers: 1, retracted: 3 }), "Heart rate", "/min");
    expect(text).toContain("Left out: 3 retracted Observations, 1 Observation with a different unit, 2 Observations with no value.");
  });

  it("says so for a day with no samples", () => {
    expect(summarize(model([]), "Heart rate", "/min")).toBe("Heart rate, 2026-09-25 (UTC): no samples.");
  });
});
