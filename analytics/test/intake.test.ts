import assert from "node:assert/strict";
import { test } from "node:test";
import { dayAsRecorded, searchSpanFor, utcDay } from "../src/day.ts";
import { MEAL_ALL, MEAL_NONE, mealOf, sumExact, totalsFor, type IntakeEntry } from "../src/intake.ts";
import { MemoryStore, type Store } from "../src/store.ts";
import { RollupWorker } from "../src/worker.ts";
import { FakeFhir, contract, energy, fiber, heartRate, intake, protein } from "./support.ts";

const D19 = "2026-10-19";
const D20 = "2026-10-20";
const window = { patientId: "p1", metricId: energy.id, day: D19 };

function make(fhir = new FakeFhir(), store: Store = new MemoryStore()) {
  return { fhir, store, worker: new RollupWorker({ name: "t", contract, fhir, store }) };
}
const totals = async (store: Store, patient = "p1") => (await store.intakeTotals(patient)).map(({ updatedAtMs: _t, ...rest }) => rest);
const row = async (store: Store, metricId: string, day: string, meal: string, patient = "p1") =>
  (await store.intakeTotals(patient)).find((t) => t.metricId === metricId && t.day === day && t.meal === meal);

// ---- the exact sum, checked against a second implementation in decimal-string arithmetic ----

/** The slow, obvious sum: decimal strings to BigInt micro-units. Shares nothing with `sumExact`. */
function referenceSum(values: readonly string[]): string {
  let micro = 0n;
  for (const v of values) {
    const [whole = "0", frac = ""] = v.split(".");
    micro += BigInt(whole) * 1_000_000n + BigInt((frac + "000000").slice(0, 6));
  }
  const text = micro.toString().padStart(7, "0");
  const w = text.slice(0, -6);
  const f = text.slice(-6).replace(/0+$/, "");
  return f ? `${w}.${f}` : w;
}

test("the sum is exact: 0.1 + 0.2 is 0.3, which a running float sum is not (the control)", () => {
  assert.notEqual(0.1 + 0.2, 0.3, "control: this is the float error the exact sum avoids");
  assert.equal(sumExact([0.1, 0.2]), 0.3);
  assert.equal(sumExact([]), 0);
});

test("amounts finer than a millionth of a unit are rounded to it, so float noise cannot reach a stored total", () => {
  assert.equal(sumExact([0.1 + 0.2]), 0.3, "0.30000000000000004 is stored as 0.3");
  assert.equal(sumExact([2.5e-7]), 0);
  assert.equal(sumExact([1.0000004, 2.0000004]), 3);
});

test("the sum agrees with an independent decimal-string sum on a seeded batch, in any order", () => {
  let seed = 7;
  const next = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let trial = 0; trial < 200; trial++) {
    const strings = Array.from({ length: 1 + Math.floor(next() * 40) }, () => (next() * 900).toFixed(Math.floor(next() * 4)));
    const expected = referenceSum(strings);
    assert.equal(String(sumExact(strings.map(Number))), expected, strings.join(" + "));
    assert.equal(String(sumExact(strings.map(Number).reverse())), expected, "order does not matter");
  }
  assert.equal(referenceSum(["0.1", "0.2"]), "0.3", "control: the reference itself is right on the classic case");
});

// ---- the day as recorded ----

test("the day is the date written in the timestamp, in its own offset: an evening entry stays on its day", () => {
  assert.equal(dayAsRecorded("2026-10-19T23:30:00-07:00"), D19);
  assert.equal(utcDay("2026-10-19T23:30:00-07:00"), D20, "control: the UTC day of the same instant is the next one");
  assert.equal(dayAsRecorded("2026-10-20T00:30:00+09:00"), D20);
  assert.equal(utcDay("2026-10-20T00:30:00+09:00"), D19, "control: and the other way round for a morning entry east of UTC");
  assert.equal(dayAsRecorded("2026-10-19T12:00:00Z"), D19);
  assert.equal(dayAsRecorded("2026-10-19T12:00:00.250+05:30"), D19);
  assert.equal(dayAsRecorded(D19), D19, "a date alone is its own day");
});

test("a time with no offset, or anything that is not a real date and instant, has no day", () => {
  for (const bad of ["2026-10-19T12:00:00", "2026-10-19T12:00", "2026-13-01T00:00:00Z", "2026-02-30", "yesterday", "", "2026-10-19T25:00:00Z"]) {
    assert.equal(dayAsRecorded(bad), null, bad);
  }
});

test("the search span holds every entry of the day at every offset from UTC-12 to UTC+14 (and the same span misses a neighbour)", () => {
  const span = searchSpanFor(D19);
  const from = Date.parse(`${span.from}T00:00:00Z`);
  const to = Date.parse(`${span.to}T00:00:00Z`);
  for (let hours = -12; hours <= 14; hours++) {
    const sign = hours < 0 ? "-" : "+";
    const off = `${sign}${String(Math.abs(hours)).padStart(2, "0")}:00`;
    for (const clock of ["00:00:00", "23:59:59"]) {
      const at = Date.parse(`${D19}T${clock}${off}`);
      assert.ok(at >= from && at < to, `${clock}${off} is outside the span`);
      assert.equal(dayAsRecorded(`${D19}T${clock}${off}`), D19);
    }
  }
  // control: the span is not "everything"
  assert.ok(Date.parse(`2026-10-16T12:00:00Z`) < from && Date.parse(`2026-10-22T12:00:00Z`) >= to);
});

// ---- totals for one day ----

const entry = (over: Partial<IntakeEntry> = {}): IntakeEntry =>
  ({ id: "e", value: 100, instantMs: Date.parse(`${D19}T12:00:00Z`), meal: null, artifactSuspected: false, lateArrival: false, ...over });

test("no entries gives no rows; only zero entries gives a total of 0 with entries counted (not the same thing)", () => {
  assert.deepEqual(totalsFor(window, energy.ucum, []), []);
  const zero = totalsFor(window, energy.ucum, [entry({ value: 0, id: "a" }), entry({ value: 0, id: "b" })]);
  assert.equal(zero[0]!.meal, MEAL_ALL);
  assert.deepEqual([zero[0]!.total, zero[0]!.n], [0, 2]);
});

test("the overall row and one row per meal: labelled meals, and entries without a meal in their own bucket", () => {
  const t = totalsFor(window, energy.ucum, [
    entry({ id: "1", value: 300, meal: "breakfast" }), entry({ id: "2", value: 700, meal: "lunch" }),
    entry({ id: "3", value: 150, meal: "lunch" }), entry({ id: "4", value: 80 }),
  ]);
  assert.deepEqual(t.map((r) => [r.meal, r.total, r.n]), [[MEAL_ALL, 1230, 4], ["breakfast", 300, 1], ["lunch", 850, 2], [MEAL_NONE, 80, 1]]);
  const parts = t.filter((r) => r.meal !== MEAL_ALL);
  assert.equal(sumExact(parts.map((r) => r.total)), t[0]!.total, "the meals add up to the day");
  assert.equal(parts.reduce((n, r) => n + r.n, 0), t[0]!.n);
});

test("first and last entry, and the flag counts (the total includes the flagged entries)", () => {
  const t = totalsFor(window, energy.ucum, [
    entry({ id: "1", value: 100, instantMs: 5_000 }), entry({ id: "2", value: 9000, instantMs: 9_000, artifactSuspected: true }),
    entry({ id: "3", value: 50, instantMs: 7_000, lateArrival: true }),
  ]);
  assert.deepEqual([t[0]!.firstMs, t[0]!.lastMs, t[0]!.nArtifact, t[0]!.nLate, t[0]!.total], [5_000, 9_000, 1, 1, 9150]);
});

test("a meal code comes from the contract's meal-type system only; an unknown code is `other`; none is null", () => {
  const meals = contract.meals!;
  const cat = (system: string, code: string) => [{ coding: [{ system, code }] }];
  assert.equal(mealOf(cat(meals.system, "lunch"), meals), "lunch");
  assert.equal(mealOf(cat(meals.system, "brunch"), meals), meals.fallback);
  assert.equal(mealOf(cat("http://example.org/other-system", "lunch"), meals), null, "another system is not a meal");
  assert.equal(mealOf(undefined, meals), null);
  assert.equal(mealOf([...cat("http://example.org/domain", "nutrition"), ...cat(meals.system, "dinner")], meals), "dinner",
    "the meal is found among several category entries");
  assert.ok(!meals.codes.includes(MEAL_ALL) && !meals.codes.includes(MEAL_NONE), "no meal code collides with a bucket name");
});

// ---- the worker ----

test("sums per patient, nutrient and day as recorded, with LOINC-coded and custom-coded nutrients", async () => {
  const { fhir, store, worker } = make();
  fhir.add(intake("p1", energy, 400, `${D19}T08:00:00-07:00`, { meal: "breakfast" }));
  fhir.add(intake("p1", energy, 650.5, `${D19}T13:00:00-07:00`, { meal: "lunch" }));
  fhir.add(intake("p1", energy, 500, `${D20}T09:00:00-07:00`));
  fhir.add(intake("p1", protein, 30, `${D19}T08:00:00-07:00`));
  fhir.add(intake("p1", fiber, 6.5, `${D19}T13:00:00-07:00`));
  fhir.add(intake("p2", energy, 9999, `${D19}T08:00:00-07:00`));
  const report = await worker.runOnce();
  assert.equal(report.scanned, 6);

  assert.deepEqual([(await row(store, energy.id, D19, MEAL_ALL))!.total, (await row(store, energy.id, D19, MEAL_ALL))!.n], [1050.5, 2]);
  assert.equal((await row(store, energy.id, D20, MEAL_ALL))!.total, 500);
  assert.equal((await row(store, protein.id, D19, MEAL_ALL))!.total, 30);
  assert.equal((await row(store, fiber.id, D19, MEAL_ALL))!.total, 6.5);
  assert.equal((await row(store, energy.id, D19, "lunch"))!.total, 650.5);
  assert.equal((await row(store, energy.id, D19, MEAL_ALL, "p2"))!.total, 9999, "another patient has its own rows");
  assert.equal((await totals(store, "p1")).filter((r) => r.metricId === energy.id && r.day === D19).length, 3, "overall + two meals");
});

test("an evening entry belongs to its own day, not the UTC day (a heart rate at the same instant still goes by UTC)", async () => {
  const { fhir, store, worker } = make();
  fhir.add(intake("p1", energy, 800, `${D19}T23:30:00-07:00`)); // 06:30 UTC on the 20th
  fhir.add(quantityAtSameInstant());
  await worker.runOnce();
  assert.equal((await row(store, energy.id, D19, MEAL_ALL))!.total, 800);
  assert.equal(await row(store, energy.id, D20, MEAL_ALL), undefined, "nothing on the UTC day");
  const bands = await store.rollups("p1");
  assert.deepEqual(bands.map((b) => [b.metricId, b.day]), [[heartRate.id, D20]], "control: a quantity at that instant is the 20th");
});
function quantityAtSameInstant() {
  return { id: "hr-1", status: "final", subject: { reference: "Patient/p1" },
    code: { coding: [{ system: contract.loincSystem, code: heartRate.loincCode }] }, effectiveDateTime: `${D19}T23:30:00-07:00`,
    valueQuantity: { value: 60, system: contract.ucumSystem, code: heartRate.ucum } };
}

test("entries in different offsets on one date share that date (a traveller), and the span search finds the extremes", async () => {
  const { fhir, store, worker } = make();
  fhir.add(intake("p1", energy, 100, `${D19}T00:05:00+14:00`)); // 10:05 UTC on the 18th
  fhir.add(intake("p1", energy, 200, `${D19}T12:00:00Z`));
  fhir.add(intake("p1", energy, 300, `${D19}T23:55:00-12:00`)); // 11:55 UTC on the 20th
  fhir.add(intake("p1", energy, 5000, `2026-10-18T23:55:00+14:00`)); // the 18th, though 09:55 UTC on the 18th is inside the span
  fhir.add(intake("p1", energy, 7000, `${D20}T00:05:00-12:00`)); // the 20th, 12:05 UTC on the 20th
  await worker.runOnce();
  const r = (await row(store, energy.id, D19, MEAL_ALL))!;
  assert.deepEqual([r.total, r.n], [600, 3]);
  assert.equal((await row(store, energy.id, "2026-10-18", MEAL_ALL))!.total, 5000, "the neighbours are their own days");
  assert.equal((await row(store, energy.id, D20, MEAL_ALL))!.total, 7000);
});

test("a day with no entries has no row; a day of zero entries has a row of 0; the zero is stored, not dropped", async () => {
  const { fhir, store, worker } = make();
  fhir.add(intake("p1", energy, 0, `${D19}T08:00:00Z`));
  fhir.add(intake("p1", energy, 0, `${D19}T09:00:00Z`));
  fhir.add(intake("p1", energy, 250, `${D20}T09:00:00Z`)); // control: a non-zero day
  await worker.runOnce();
  const zero = (await row(store, energy.id, D19, MEAL_ALL))!;
  assert.deepEqual([zero.total, zero.n], [0, 2]);
  assert.equal((await row(store, energy.id, D20, MEAL_ALL))!.total, 250);
  assert.equal(await row(store, energy.id, "2026-10-21", MEAL_ALL), undefined, "no entries: no row, never a 0");
});

test("retracting one entry lowers the day; retracting the last removes the day (it becomes 'no entries', not 0)", async () => {
  const { fhir, store, worker } = make();
  const a = intake("p1", energy, 400, `${D19}T08:00:00Z`, { meal: "breakfast" });
  const b = intake("p1", energy, 600, `${D19}T13:00:00Z`, { meal: "lunch" });
  fhir.add(a); fhir.add(b);
  await worker.runOnce();
  const before = (await row(store, energy.id, D19, MEAL_ALL))!;
  assert.deepEqual([before.total, before.revision], [1000, 1]);

  fhir.retract(b.id, fhir.serverNow + 60_000);
  fhir.serverNow += 120_000;
  await worker.runOnce();
  const after = (await row(store, energy.id, D19, MEAL_ALL))!;
  assert.deepEqual([after.total, after.n, after.revision], [400, 1, 2]);
  assert.equal(await row(store, energy.id, D19, "lunch"), undefined, "the lunch row is gone with its only entry");

  fhir.retract(a.id, fhir.serverNow + 60_000);
  fhir.serverNow += 120_000;
  await worker.runOnce();
  assert.deepEqual(await totals(store), [], "no row at all");
});

test("an edit (the old entry retracted, a new one written) shows the new amount only", async () => {
  const { fhir, store, worker } = make();
  const old = intake("p1", energy, 500, `${D19}T12:00:00Z`, { meal: "lunch" });
  fhir.add(old);
  await worker.runOnce();
  fhir.retract(old.id, fhir.serverNow + 60_000);
  fhir.add(intake("p1", energy, 620, `${D19}T12:00:00Z`, { meal: "lunch" }), fhir.serverNow + 61_000);
  fhir.serverNow += 120_000;
  await worker.runOnce();
  const r = (await row(store, energy.id, D19, MEAL_ALL))!;
  assert.deepEqual([r.total, r.n], [620, 1]);
});

test("running again changes nothing, and the second run really re-read (the control)", async () => {
  const { fhir, store, worker } = make();
  for (let i = 0; i < 6; i++) {
    fhir.add(intake("p1", energy, 100 + i, `${D19}T0${i}:00:00Z`, i % 2 ? { meal: "snack" } : {}));
  }
  await worker.runOnce();
  const first = await store.intakeTotals("p1");
  const again = await worker.runOnce();
  assert.ok(again.recomputed > 0);
  assert.equal(again.changed, 0);
  assert.deepEqual(await store.intakeTotals("p1"), first);
});

test("a late entry changes only its own day", async () => {
  const { fhir, store, worker } = make();
  fhir.add(intake("p1", energy, 100, `${D19}T08:00:00Z`));
  fhir.add(intake("p1", energy, 200, `${D20}T08:00:00Z`));
  await worker.runOnce();
  fhir.serverNow += 3_600_000;
  fhir.add(intake("p1", energy, 50, `${D19}T21:00:00Z`));
  const report = await worker.runOnce();
  assert.equal(report.changed, 1);
  assert.deepEqual([(await row(store, energy.id, D19, MEAL_ALL))!.total, (await row(store, energy.id, D19, MEAL_ALL))!.revision], [150, 2]);
  assert.equal((await row(store, energy.id, D20, MEAL_ALL))!.revision, 1);
});

test("the wrong unit is left out and counted, a negative amount is left out and counted, a non-final status is left out", async () => {
  const { fhir, store, worker } = make();
  fhir.add(intake("p1", energy, 100, `${D19}T08:00:00Z`)); // the control that counts
  fhir.add(intake("p1", energy, 5, `${D19}T09:00:00Z`, { overrides: { valueQuantity: { value: 5, system: contract.ucumSystem, code: "J" } } }));
  fhir.add(intake("p1", energy, -50, `${D19}T10:00:00Z`));
  fhir.add(intake("p1", energy, 70, `${D19}T11:00:00Z`, { overrides: { status: "preliminary" } }));
  fhir.add(intake("p1", energy, 80, `${D19}T12:00:00Z`, { overrides: { status: "entered-in-error" } }));
  const report = await worker.runOnce();
  assert.deepEqual([report.wrongUnit, report.invalidValue], [1, 1]);
  const r = (await row(store, energy.id, D19, MEAL_ALL))!;
  assert.deepEqual([r.total, r.n], [100, 1]);
});

test("an entry with no offset on its time has no day: ignored and counted, never filed under a guessed day", async () => {
  const { fhir, store, worker } = make();
  fhir.add(intake("p1", energy, 100, `${D19}T08:00:00Z`)); // control
  fhir.add(intake("p1", energy, 999, `${D19}T08:00:00`));
  const report = await worker.runOnce();
  assert.equal(report.ignored >= 1, true);
  assert.equal((await row(store, energy.id, D19, MEAL_ALL))!.total, 100);
});

test("flags are counted from the stored tags only; the flagged entry is still in the total", async () => {
  const { fhir, store, worker } = make();
  fhir.add(intake("p1", energy, 100, `${D19}T08:00:00Z`));
  fhir.add(intake("p1", energy, 7000, `${D19}T09:00:00Z`), fhir.serverNow, [{ system: contract.flags.system, code: contract.flags.artifactSuspected }]);
  fhir.add(intake("p1", energy, 60, `${D19}T10:00:00Z`), fhir.serverNow, [{ system: contract.flags.system, code: contract.flags.lateArrival }]);
  fhir.add(intake("p1", energy, 8000, `${D19}T11:00:00Z`)); // implausible, but carries no tag: not inferred
  fhir.add(intake("p1", energy, 5, `${D19}T12:00:00Z`), fhir.serverNow, [{ system: "http://example.org/other", code: contract.flags.artifactSuspected }]);
  await worker.runOnce();
  const r = (await row(store, energy.id, D19, MEAL_ALL))!;
  assert.deepEqual([r.total, r.nArtifact, r.nLate], [15165, 1, 1]);
});

test("the scan asks for every intake code with its own system, and the day search carries the widened span", async () => {
  const { fhir, worker } = make();
  fhir.add(intake("p1", fiber, 5, `${D19}T08:00:00Z`));
  await worker.runOnce();
  const scan = decodeURIComponent(fhir.requests[0]!);
  for (const m of contract.intakeMetrics) {
    assert.ok(scan.includes(`${m.codeSystem}|${m.code}`), `${m.id} missing from the scan`);
  }
  assert.notEqual(contract.intakeMetrics.find((m) => m.codeSystem !== contract.loincSystem), undefined, "control: one nutrient is in the contract's own system");
  const recompute = decodeURIComponent(fhir.requests.find((r) => r.includes("subject="))!);
  assert.match(recompute, /date=ge2026-10-18T00:00:00Z/);
  assert.match(recompute, /date=lt2026-10-21T00:00:00Z/);
});

test("a nutrient the contract does not have is not summed, and a quantity metric is not mistaken for one", async () => {
  const { fhir, store, worker } = make();
  fhir.add(intake("p1", { codeSystem: contract.loincSystem, code: "0000-0", ucum: "kcal" }, 100, `${D19}T08:00:00Z`));
  fhir.add(intake("p1", energy, 100, `${D19}T08:00:00Z`)); // control
  await worker.runOnce();
  assert.deepEqual((await totals(store)).map((r) => r.metricId), [energy.id, energy.id]);
});

test("the worker does not trust the server's code filter: another nutrient (same unit) that comes back is not summed", async () => {
  assert.equal(protein.ucum, fiber.ucum, "control: the two share a unit, so only the code check can tell them apart");
  const { fhir, store, worker } = make();
  fhir.add(intake("p1", protein, 30, `${D19}T08:00:00Z`));
  fhir.add(intake("p1", fiber, 7, `${D19}T09:00:00Z`));
  fhir.ignoreCodeFilter = true; // every search now returns both nutrients
  await worker.runOnce();
  const p = (await row(store, protein.id, D19, MEAL_ALL))!;
  const f = (await row(store, fiber.id, D19, MEAL_ALL))!;
  assert.deepEqual([p.total, p.n, f.total, f.n], [30, 1, 7, 1]);
});
