import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ASLEEP_STAGES, AWAKE_STAGE, MIN_AWAKENING_MS, SESSION_GAP_MS, affectedNights, buildSessions, fetchRange, resolve,
  type StageInterval,
} from "../src/sleep.ts";
import { contract } from "./support.ts";

const MIN = 60_000;
const T0 = Date.parse("2026-10-06T23:00:00.000Z"); // 23:00 UTC

let n = 0;
/** `iv("asleepCore", 0, 35)` = 35 minutes of core sleep starting 0 minutes after 23:00 UTC. */
const iv = (stage: string, fromMin: number, toMin: number, id?: string): StageInterval => ({
  id: id ?? `iv-${++n}`, stage, startMs: T0 + fromMin * MIN, endMs: T0 + toMin * MIN,
});

/**
 * A synthetic night with exactly known totals (minutes after 23:00 UTC):
 *   0-10 awake (latency 10) | 10-50 core 40 | 50-80 deep 30 | 80-85 awake (5, an awakening) | 85-130 core 45
 *   130-160 REM 30 | 160-162 awake (2, too short) | 162-222 REM 60 | 222-240 unspecified 18 | 240-250 awake (10, after final waking)
 */
const night = (): StageInterval[] => [
  iv("awake", 0, 10), iv("asleepCore", 10, 50), iv("asleepDeep", 50, 80), iv("awake", 80, 85),
  iv("asleepCore", 85, 130), iv("asleepREM", 130, 160), iv("awake", 160, 162), iv("asleepREM", 162, 222),
  iv("asleepUnspecified", 222, 240), iv("awake", 240, 250),
];

test("a known night yields the expected stage totals", () => {
  const [s, ...rest] = buildSessions("p1", night());
  assert.equal(rest.length, 0);
  assert.ok(s);
  assert.equal(s.night, "2026-10-07"); // final waking at 03:00 UTC on the 7th
  assert.equal(s.latencyMin, 10);
  assert.equal(s.coreMin, 85);
  assert.equal(s.deepMin, 30);
  assert.equal(s.remMin, 90);
  assert.equal(s.unspecifiedMin, 18);
  assert.equal(s.asleepMin, 223);
  assert.equal(s.awakeMin, 7); // 5 + 2 between onset and final waking
  assert.equal(s.awakenings, 1); // only the 5-minute one reaches the threshold
  assert.equal(s.wakeAfterEndMin, 10);
  assert.equal(s.unscoredMin, 0);
  assert.equal(s.overlapMin, 0);
  assert.equal(s.isMain, true);
  assert.equal(s.onsetMs, T0 + 10 * MIN);
  assert.equal(s.lastAsleepEndMs, T0 + 240 * MIN);
  assert.equal(s.intervalCount, 10);
});

test("the threshold is inclusive and one millisecond under it does not count", () => {
  const exact = [iv("asleepCore", 0, 60), iv("awake", 60, 65), iv("asleepCore", 65, 120)];
  assert.equal(buildSessions("p", exact)[0]!.awakenings, 1);
  const short = [iv("asleepCore", 0, 60), { ...iv("awake", 60, 65), endMs: T0 + 65 * MIN - 1 }, iv("asleepCore", 65, 120)];
  assert.equal(short.length, 3);
  assert.equal(MIN_AWAKENING_MS, 5 * MIN); // the constant the test above is about
  const s = buildSessions("p", short)[0]!;
  assert.equal(s.awakenings, 0);
  assert.ok(s.awakeMin > 4.99 && s.awakeMin < 5);
});

test("results do not depend on the order intervals arrive in", () => {
  const a = buildSessions("p1", night());
  const b = buildSessions("p1", [...night()].reverse());
  assert.deepEqual(a, b);
});

test("a gap inside a session is reported as unscored time, not silently absorbed", () => {
  const withGap = [iv("asleepCore", 0, 60), iv("asleepCore", 90, 150)]; // 30 min with no data
  const s = buildSessions("p", withGap)[0]!;
  assert.equal(s.unscoredMin, 30);
  assert.equal(s.asleepMin, 120);
  assert.equal(buildSessions("p", withGap).length, 1);
});

test("a gap longer than the session gap splits sessions; exactly the gap does not", () => {
  const gap = SESSION_GAP_MS / MIN;
  const split = [iv("asleepCore", 0, 60), iv("asleepCore", 60 + gap + 1, 120 + gap + 1)];
  assert.equal(buildSessions("p", split).length, 2);
  const joined = [iv("asleepCore", 0, 60), iv("asleepCore", 60 + gap, 120 + gap)];
  assert.equal(buildSessions("p", joined).length, 1);
});

test("overlapping intervals: the later start wins, and the overlap is reported", () => {
  // core 0-60 overlaps deep 40-90: 40-60 is deep (later start), so core 40 min, deep 50 min, overlap 20 min
  const s = buildSessions("p", [iv("asleepCore", 0, 60), iv("asleepDeep", 40, 90)])[0]!;
  assert.equal(s.coreMin, 40);
  assert.equal(s.deepMin, 50);
  assert.equal(s.overlapMin, 20);
  assert.equal(s.asleepMin, 90);
});

test("identical duplicate intervals (different ids) count once", () => {
  const s = buildSessions("p", [iv("asleepCore", 0, 60, "a"), iv("asleepCore", 0, 60, "b")])[0]!;
  assert.equal(s.coreMin, 60);
  assert.equal(s.overlapMin, 60);
});

test("same start and an equal-rank conflict resolves deterministically by id", () => {
  const x = buildSessions("p", [iv("asleepDeep", 0, 60, "a"), iv("asleepCore", 0, 60, "b")])[0]!;
  const y = buildSessions("p", [iv("asleepCore", 0, 60, "b"), iv("asleepDeep", 0, 60, "a")])[0]!;
  assert.deepEqual(x, y);
  assert.equal(x.deepMin, 60); // the more specific stage wins the tie
});

test("only awake time is not a sleep session", () => {
  assert.deepEqual(buildSessions("p", [iv("awake", 0, 120)]), []);
});

test("a nap is its own session; the longer sleep on the same date is main", () => {
  const morningNap = [iv("asleepCore", 0, 60)]; // 23:00-00:00 UTC, wake date the 7th
  const main = [iv("asleepCore", 60 + 200, 60 + 200 + 120)]; // 03:20 onward, more than 2 h after the nap: its own session
  const sessions = buildSessions("p", [...morningNap, ...main]);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((s) => s.night), ["2026-10-07", "2026-10-07"]);
  assert.deepEqual(sessions.map((s) => s.isMain), [false, true]);
});

test("the night date is the UTC date of the final waking, across midnight and a month end", () => {
  const monthEnd = Date.parse("2026-10-31T22:00:00.000Z");
  const s = buildSessions("p", [{ id: "x", stage: "asleepCore", startMs: monthEnd, endMs: monthEnd + 4 * 60 * MIN }])[0]!;
  assert.equal(s.night, "2026-11-01");
});

test("stages the module does not know are ignored rather than miscounted", () => {
  const s = buildSessions("p", [iv("asleepCore", 0, 60), iv("inBed", 0, 120), iv("mystery", 0, 90)])[0]!;
  assert.equal(s.asleepMin, 60);
  assert.equal(s.intervalCount, 1);
});

test("zero-length and inverted intervals are dropped", () => {
  assert.deepEqual(resolve([iv("asleepCore", 10, 10), iv("asleepCore", 30, 20)]).segments, []);
});

test("affectedNights covers the neighbouring dates a merge or extension could change", () => {
  const s = Date.parse("2026-10-06T23:00:00.000Z"), e = Date.parse("2026-10-07T03:00:00.000Z");
  const nights = affectedNights(s, e);
  assert.deepEqual(nights, ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
  assert.ok(nights.includes("2026-10-07")); // the night itself (wake date)
});

test("fetchRange is wider than any session that ends on the night", () => {
  const { fromMs, toMs } = fetchRange("2026-10-07");
  assert.equal(new Date(fromMs).toISOString(), "2026-10-05T00:00:00.000Z");
  assert.equal(new Date(toMs).toISOString(), "2026-10-10T00:00:00.000Z");
});

test("every stage the contract defines is classified by this module (a new stage must fail here, loudly)", () => {
  const known = new Set<string>([...ASLEEP_STAGES, AWAKE_STAGE]);
  const stages = [...contract.sleep!.stageByCode.values()];
  assert.ok(stages.length >= 5, "control: the contract has its stages");
  for (const stage of stages) {
    assert.ok(known.has(stage), `contract sleep stage ${stage} is not classified in sleep.ts`);
  }
  assert.ok(contract.sleep!.unmapped.includes("inBed"));
});
