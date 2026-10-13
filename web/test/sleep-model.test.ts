import { describe, expect, it } from "vitest";
import type { Observation } from "../src/fhir/types.ts";
import {
  clockAt, clockNote, nightStats, nightSummary, offsetsIn, recorded, resolveTimeline, spansClockChange, toStageInterval,
  type StageInterval,
} from "../src/sleep/model.ts";
import { contract } from "./support.ts";

const code = (stage: string) => contract.sleepStages.find((s) => s.id === stage)!.loincCode;
const obsOf = (stage: string, start: string, end: string, id: string, extra: Partial<Observation> = {}): Observation => ({
  resourceType: "Observation", id, status: "final",
  code: { coding: [{ system: contract.loincSystem, code: code(stage) }] },
  effectivePeriod: { start, end }, valueQuantity: { value: 1, unit: "min" }, ...extra,
});
const iv = (stage: string, start: string, end: string, id: string): StageInterval => {
  const r = toStageInterval(obsOf(stage, start, end, id), contract);
  if (typeof r === "string") throw new Error(r);
  return r;
};

/** The "known night" of the verification data, in PDT (-07:00): see web/tools/seed-sleep-nights.mjs. */
const d = (hhmm: string, day = "2026-09-28") => `${day}T${hhmm}:00+00:00`;
const KNOWN: StageInterval[] = [
  iv("awake", d("05:30"), d("06:00"), "a1"), iv("asleepCore", d("06:00"), d("06:45"), "a2"), iv("asleepDeep", d("06:45"), d("07:30"), "a3"),
  iv("asleepCore", d("07:30"), d("08:00"), "a4"), iv("awake", d("08:00"), d("08:03"), "a5"), iv("asleepREM", d("08:03"), d("09:00"), "a6"),
  iv("asleepCore", d("09:00"), d("09:20"), "a7"), iv("asleepUnspecified", d("09:10"), d("09:40"), "a8"),
  iv("asleepDeep", d("09:50"), d("10:20"), "a9"), iv("awake", d("10:20"), d("10:30"), "a10"), iv("asleepCore", d("10:30"), d("12:00"), "a11"),
  iv("asleepREM", d("12:00"), d("13:00"), "a12"), iv("awake", d("13:00"), d("13:30"), "a13"),
];

describe("toStageInterval", () => {
  it("reads a stage interval by its LOINC code through the contract, keeping the recorded strings", () => {
    const r = toStageInterval(obsOf("asleepREM", "2026-09-28T01:03:00-07:00", "2026-09-28T02:00:00-07:00", "x"), contract) as StageInterval;
    expect(r.stage).toBe("asleepREM");
    expect(r.endMs - r.startMs).toBe(57 * 60_000);
    expect(r.start).toBe("2026-09-28T01:03:00-07:00");
  });

  it.each([
    ["retracted", { status: "entered-in-error" } as Partial<Observation>],
    ["noPeriod", { effectivePeriod: undefined }],
    ["empty", { effectivePeriod: { start: "2026-09-28T01:00:00Z", end: "2026-09-28T01:00:00Z" } }],
  ])("skips %s", (reason, over) => {
    const o = { ...obsOf("asleepCore", "2026-09-28T01:00:00Z", "2026-09-28T02:00:00Z", "x"), ...over };
    if (over.effectivePeriod === undefined && reason === "noPeriod") delete (o as Observation).effectivePeriod;
    expect(toStageInterval(o as Observation, contract)).toBe(reason);
  });

  it("skips an unknown code (positive control: a known stage code is read)", () => {
    const o = obsOf("asleepCore", "2026-09-28T01:00:00Z", "2026-09-28T02:00:00Z", "x");
    o.code = { coding: [{ system: contract.loincSystem, code: "0000-0" }] };
    expect(toStageInterval(o, contract)).toBe("unknownStage");
    expect(typeof toStageInterval(obsOf("asleepCore", "2026-09-28T01:00:00Z", "2026-09-28T02:00:00Z", "y"), contract)).toBe("object");
  });
});

describe("resolveTimeline: one stage per instant, the interval that starts later wins", () => {
  it("resolves the overlap and leaves the gap unscored", () => {
    const seg = resolveTimeline(KNOWN);
    const at = (hhmm: string) => seg.find((s) => s.startMs <= Date.parse(d(hhmm)) && Date.parse(d(hhmm)) < s.endMs)!;
    expect(at("09:05").stage).toBe("asleepCore"); // before the later interval starts
    expect(at("09:15").stage).toBe("asleepUnspecified"); // both cover it: the later start wins
    expect(at("09:15").covered).toBe(2);
    expect(at("09:45").stage).toBeNull(); // nothing covers 09:40-09:50
    expect(at("09:45").covered).toBe(0);
    // every instant has exactly one stage: the segments never overlap and never go backwards
    for (let i = 1; i < seg.length; i++) expect(seg[i]!.startMs).toBeGreaterThanOrEqual(seg[i - 1]!.endMs);
  });

  it("with equal starts, the more specific stage wins; then the lower id (control: the later start still wins first)", () => {
    const tie = [iv("asleepCore", d("01:00"), d("02:00"), "b"), iv("asleepDeep", d("01:00"), d("02:00"), "a")];
    expect(resolveTimeline(tie)[0]!.stage).toBe("asleepDeep");
    const sameStage = [iv("asleepCore", d("01:00"), d("02:00"), "z"), iv("asleepCore", d("01:00"), d("02:00"), "y")];
    expect(resolveTimeline(sameStage)[0]!.source!.id).toBe("y");
    const later = [iv("asleepDeep", d("01:00"), d("02:00"), "a"), iv("asleepCore", d("01:30"), d("01:50"), "b")];
    expect(resolveTimeline(later).find((s) => s.stage === "asleepCore")!.startMs).toBe(Date.parse(d("01:30")));
  });

  it("is empty for no intervals", () => {
    expect(resolveTimeline([])).toEqual([]);
    expect(nightStats([])).toBeNull();
  });
});

describe("nightStats on the known night (computed by hand, and by the independent per-minute reader)", () => {
  const stats = nightStats(resolveTimeline(KNOWN))!;

  it.each([
    ["asleepMin", 397], ["coreMin", 175], ["deepMin", 75], ["remMin", 117], ["unspecifiedMin", 30], ["awakeMin", 13],
    ["unscoredMin", 10], ["overlapMin", 10], ["awakenings", 1], ["latencyMin", 30], ["wakeAfterEndMin", 30],
  ] as const)("%s = %d", (key, value) => {
    expect(stats[key]).toBe(value);
  });

  it("a 3-minute awake is not an awakening, a 10-minute one is", () => {
    // 08:00-08:03 and 10:20-10:30 are both awake between onset and waking: only the second counts
    expect(stats.awakeMin).toBe(13);
    expect(stats.awakenings).toBe(1);
  });

  it("awake time before onset and after the final waking is latency and wake-after-end, not awake time", () => {
    expect(stats.onsetMs).toBe(Date.parse(d("06:00")));
    expect(stats.finalWakingMs).toBe(Date.parse(d("13:00")));
  });

  it("two adjacent awake intervals are one awakening (control for the threshold)", () => {
    const two = [
      iv("asleepCore", d("01:00"), d("02:00"), "a"), iv("awake", d("02:00"), d("02:03"), "b"), iv("awake", d("02:03"), d("02:07"), "c"),
      iv("asleepCore", d("02:07"), d("03:00"), "e"),
    ];
    const s = nightStats(resolveTimeline(two))!;
    expect(s.awakeMin).toBe(7);
    expect(s.awakenings).toBe(1); // 3 + 4 minutes, contiguous: one 7-minute awakening
  });

  it("a night with no asleep stage has no onset", () => {
    const only = nightStats(resolveTimeline([iv("awake", d("01:00"), d("02:00"), "a")]))!;
    expect(only.onsetMs).toBeNull();
    expect(only.asleepMin).toBe(0);
  });
});

describe("time as recorded, and a clock change", () => {
  it("reads the device's wall clock and offset from the string, never the browser's zone", () => {
    expect(recorded("2026-09-28T23:05:30-07:00")).toMatchObject({ date: "2026-09-28", hhmm: "23:05", offset: "-07:00" });
    expect(recorded("2026-03-08T07:00:00Z")).toMatchObject({ hhmm: "07:00", offset: "+00:00" });
    expect(recorded("nonsense")).toBeNull();
  });

  // the DST night: PST (-08:00) until 02:00 became 03:00 PDT (-07:00) at 10:00Z; one interval spans the change
  const P = "2026-03-08";
  const dst = [
    iv("asleepCore", `${P}T23:00:00-08:00`.replace(P, "2026-03-07"), `${P}T23:45:00-08:00`.replace(P, "2026-03-07"), "d1"),
    iv("asleepDeep", "2026-03-07T23:45:00-08:00", "2026-03-08T00:30:00-08:00", "d2"),
    iv("asleepREM", "2026-03-08T00:30:00-08:00", "2026-03-08T01:30:00-08:00", "d3"),
    iv("asleepCore", "2026-03-08T01:30:00-08:00", "2026-03-08T03:30:00-07:00", "d4"), // spans the change
    iv("asleepDeep", "2026-03-08T03:30:00-07:00", "2026-03-08T04:30:00-07:00", "d5"),
    iv("awake", "2026-03-08T04:30:00-07:00", "2026-03-08T05:00:00-07:00", "d6"),
  ];

  it("notices that the offset changed, and which interval it changed in", () => {
    expect(offsetsIn(dst)).toEqual(["-08:00", "-07:00"]);
    expect(dst.filter(spansClockChange).map((i) => i.id)).toEqual(["d4"]);
    expect(offsetsIn([dst[0]!, dst[1]!])).toEqual(["-08:00"]); // control: a night without a change
  });

  it("gives the clock before and after the change, and no invented time inside it", () => {
    const t = (iso: string) => Date.parse(iso);
    expect(clockAt(t("2026-03-08T01:00:00-08:00"), dst)).toEqual({ hhmm: "01:00", offset: "-08:00" });
    expect(clockAt(t("2026-03-08T04:00:00-07:00"), dst)).toEqual({ hhmm: "04:00", offset: "-07:00" });
    expect(clockAt(t("2026-03-08T10:00:00Z"), dst)).toBeNull(); // 10:00Z is inside d4, whose clock changed
    expect(clockAt(t("2026-03-08T01:30:00-08:00"), dst)).toEqual({ hhmm: "01:30", offset: "-08:00" }); // its start is known
    expect(clockAt(t("2026-03-08T03:30:00-07:00"), dst)).toEqual({ hhmm: "03:30", offset: "-07:00" }); // and its end
  });

  it("states real time against clock time: a 23-hour day loses an hour", () => {
    const start = Date.parse("2026-03-07T23:00:00-08:00");
    const end = Date.parse("2026-03-08T05:00:00-07:00");
    const note = clockNote(dst, start, end);
    expect(note.offsets).toEqual(["-08:00", "-07:00"]);
    expect(Math.round(note.clockMinusElapsedMin)).toBe(60); // the clock reads 6 h, 5 h really elapsed
    // control: no change, no difference
    const plain = [dst[0]!, dst[1]!];
    expect(clockNote(plain, plain[0]!.startMs, plain[1]!.endMs).clockMinusElapsedMin).toBe(0);
  });

  it("the summary says so in words", () => {
    const stats = nightStats(resolveTimeline(dst))!;
    const text = nightSummary(stats, dst, true);
    expect(text).toMatch(/offset changed during this night \(UTC-08:00 then UTC-07:00\)/);
    expect(text).toMatch(/real time, .* on the clock/);
    const plain = [dst[0]!, dst[1]!];
    expect(nightSummary(nightStats(resolveTimeline(plain))!, plain, true)).not.toMatch(/offset changed/);
  });
});
