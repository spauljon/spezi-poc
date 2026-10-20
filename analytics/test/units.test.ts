import assert from "node:assert/strict";
import { test } from "node:test";
import { isDay, nextDay, utcDay } from "../src/day.ts";
import { summarize } from "../src/rollup.ts";

test("utcDay uses the instant, not the offset the sample carries", () => {
  assert.equal(utcDay("2026-10-10T12:00:00+00:00"), "2026-10-10");
  // 22:30 on the 10th in New York is already the 11th in UTC
  assert.equal(utcDay("2026-10-10T22:30:00-04:00"), "2026-10-11");
  // 01:30 on the 11th in Tokyo is still the 10th in UTC
  assert.equal(utcDay("2026-10-11T01:30:00+09:00"), "2026-10-10");
  // the same instant written with different offsets is the same day
  assert.equal(utcDay("2026-03-08T01:59:59-05:00"), utcDay("2026-03-08T06:59:59+00:00"));
});

test("utcDay rejects what is not an instant, and handles instants with fractions", () => {
  assert.equal(utcDay("not a date"), null);
  assert.equal(utcDay(""), null);
  assert.equal(utcDay("2026-10-10T23:59:59.999+00:00"), "2026-10-10");
  assert.equal(utcDay("2026-10-11T00:00:00.000+00:00"), "2026-10-11");
});

test("UTC days have no DST: the days around a US spring-forward are all 24 hours", () => {
  const days = ["2026-03-07", "2026-03-08", "2026-03-09"];
  for (const day of days) {
    const hours = (Date.parse(`${nextDay(day)}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 3_600_000;
    assert.equal(hours, 24);
  }
});

test("nextDay crosses month, year and leap-day boundaries", () => {
  assert.equal(nextDay("2026-10-31"), "2026-11-01");
  assert.equal(nextDay("2026-12-31"), "2027-01-01");
  assert.equal(nextDay("2028-02-28"), "2028-02-29");
  assert.equal(nextDay("2027-02-28"), "2027-03-01");
});

test("isDay accepts real dates only", () => {
  assert.equal(isDay("2026-10-12"), true);
  assert.equal(isDay("2026-13-01"), false);
  assert.equal(isDay("2026-10-12T00:00:00Z"), false);
});

test("summarize: count, min, median, max", () => {
  assert.deepEqual(summarize([3, 1, 2]), { n: 3, min: 1, median: 2, max: 3 });
  assert.deepEqual(summarize([4, 1, 3, 2]), { n: 4, min: 1, median: 2.5, max: 4 });
  assert.deepEqual(summarize([7]), { n: 1, min: 7, median: 7, max: 7 });
  assert.deepEqual(summarize([5, 5, 5, 9]), { n: 4, min: 5, median: 5, max: 9 });
});

test("summarize ignores non-finite values and returns null for nothing", () => {
  assert.equal(summarize([]), null);
  assert.equal(summarize([Number.NaN, Infinity]), null);
  assert.deepEqual(summarize([Number.NaN, 2, 4]), { n: 2, min: 2, median: 3, max: 4 });
});

test("summarize does not depend on input order and does not mutate its input", () => {
  const input = [9, 1, 5, 3];
  const before = [...input];
  assert.deepEqual(summarize(input), summarize([...input].reverse()));
  assert.deepEqual(input, before);
});

test("isDay rejects a date that only parses by rolling over, and still accepts a real leap day (the control)", async () => {
  assert.equal(isDay("2024-02-29"), true);
  assert.equal(isDay("2026-02-29"), false);
  assert.equal(isDay("2026-02-30"), false);
  assert.equal(isDay("2026-04-31"), false);
  assert.equal(isDay("2026-10-31"), true);
});
