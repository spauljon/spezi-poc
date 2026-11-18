import assert from "node:assert/strict";
import { test } from "node:test";
import { RollupWorker } from "../src/worker.ts";
import type { Store } from "../src/store.ts";
import { MemoryStore } from "../src/store.ts";
import { FakeFhir, contract, energy, heartRate, hrv, intake, quantity, rmssd, sleepStage } from "./support.ts";

/**
 * M29 (decision A11): HAPI deletes softly, so a deleted Android sample is invisible to a search and to `_lastUpdated`.
 * The worker reads `Observation/_history` for DELETE entries and recomputes the window each one belonged to. These tests
 * use a fake server that behaves like that, and each negative has its positive beside it.
 */
const TUE = "2026-10-06";
const T0 = Date.parse("2026-10-06T12:00:00.000Z");

function make(clock = { now: T0 }) {
  const fhir = new FakeFhir();
  const store: Store = new MemoryStore();
  fhir.serverNow = clock.now; // the fake server's clock starts at the worker's
  const worker = new RollupWorker({ name: "t", contract, fhir, store, now: () => clock.now });
  return { fhir, store, worker, clock };
}

const rollup = async (store: Store, metric: string, day = TUE) =>
  (await store.rollups()).find((r) => r.patientId === "p1" && r.metricId === metric && r.day === day);

// ---- heart-rate variability as Health Connect measures it (hrvRmssd, own code system) ----
test("RMSSD is rolled up under its own code system, apart from SDNN", async () => {
  const { fhir, store, worker } = make();
  fhir.add(quantity("p1", rmssd, 48.3, `${TUE}T09:00:00+00:00`));
  fhir.add(quantity("p1", rmssd, 52, `${TUE}T10:00:00+00:00`));
  fhir.add(quantity("p1", hrv, 41, `${TUE}T09:00:00+00:00`)); // SDNN, LOINC: a different measure, a different row
  await worker.runOnce();
  assert.equal((await rollup(store, "hrvRmssd"))?.n, 2);
  assert.equal((await rollup(store, "hrvRmssd"))?.min, 48.3);
  assert.equal((await rollup(store, "hrvSdnn"))?.n, 1, "control: the LOINC-coded SDNN is still rolled up, separately");
  assert.equal(rmssd.codeSystem === hrv.codeSystem, false, "the two measures are coded in different systems");
});

test("an RMSSD code under another system is not RMSSD (the system is part of the code)", async () => {
  const { fhir, store, worker } = make();
  fhir.ignoreCodeFilter = true; // a server that returns everything: the worker's own check of code AND system is the guard
  fhir.add(quantity("p1", { ...rmssd, codeSystem: "http://example.org/other" }, 99, `${TUE}T09:00:00+00:00`));
  fhir.add(quantity("p1", rmssd, 48, `${TUE}T10:00:00+00:00`));
  await worker.runOnce();
  assert.equal((await rollup(store, "hrvRmssd"))?.n, 1, "only the contract's own system counts");
  assert.equal((await rollup(store, "hrvRmssd"))?.max, 48);
});

// ---- deletions ----
test("a deleted sample leaves its day's rollup, and the last one removes the row", async () => {
  const { fhir, store, worker, clock } = make();
  fhir.add(quantity("p1", heartRate, 60, `${TUE}T08:00:00+00:00`));
  fhir.add(quantity("p1", heartRate, 80, `${TUE}T09:00:00+00:00`));
  const doomed = fhir.add2(quantity("p1", heartRate, 100, `${TUE}T10:00:00+00:00`));
  await worker.runOnce();
  assert.deepEqual([(await rollup(store, "heartRate"))?.n, (await rollup(store, "heartRate"))?.max], [3, 100]);

  clock.now += 60_000;
  fhir.serverNow = clock.now;
  fhir.remove(doomed, clock.now);
  const report = await worker.runOnce();
  assert.equal(report.deletions, 1);
  assert.deepEqual([(await rollup(store, "heartRate"))?.n, (await rollup(store, "heartRate"))?.max], [2, 80], "the day shrank");
  assert.equal((await rollup(store, "heartRate"))?.revision, 2);

  // the control: reading the same deletion again (the scan re-reads its newest minute, the overlap) changes nothing, revision included
  const again = await worker.runOnce();
  assert.equal(again.changed, 0);
  assert.equal((await rollup(store, "heartRate"))?.revision, 2);

  // delete the rest: the day has no data, which is no row (never a stored zero)
  for (const r of [...(await fhirIds(fhir))]) {
    clock.now += 60_000;
    fhir.remove(r, clock.now);
  }
  await worker.runOnce();
  assert.equal(await rollup(store, "heartRate"), undefined);
});

async function fhirIds(fhir: FakeFhir): Promise<string[]> {
  const ids: string[] = [];
  for await (const o of fhir.search("Observation")) ids.push(o.id);
  return ids;
}

test("a deleted dietary entry and a deleted sleep stage are recomputed too", async () => {
  const { fhir, store, worker, clock } = make();
  const a = fhir.add2(intake("p1", energy, 400, `${TUE}T08:00:00+00:00`, { meal: "breakfast" }));
  fhir.add(intake("p1", energy, 600, `${TUE}T12:00:00+00:00`, { meal: "lunch" }));
  const stage = fhir.add2(sleepStage("p1", "asleepDeep", `${TUE}T02:00:00Z`, `${TUE}T03:00:00Z`));
  fhir.add(sleepStage("p1", "asleepCore", `${TUE}T03:00:00Z`, `${TUE}T04:00:00Z`));
  await worker.runOnce();
  const total = async () => (await store.intakeTotals("p1")).find((t) => t.metricId === "dietaryEnergy" && t.meal === "all")?.total;
  assert.equal(await total(), 1000);
  const deepBefore = (await store.nights("p1")).reduce((n, s) => n + s.deepMin, 0);
  assert.equal(deepBefore, 60);

  clock.now += 60_000;
  fhir.remove(a, clock.now);
  fhir.remove(stage, clock.now);
  const report = await worker.runOnce();
  assert.equal(report.deletions, 2);
  assert.equal(await total(), 600, "the breakfast left the day");
  assert.equal((await store.nights("p1")).reduce((n, s) => n + s.deepMin, 0), 0, "the deleted stage left the night");
  assert.ok((await store.nights("p1")).reduce((n, s) => n + s.coreMin, 0) > 0, "control: the stage that was not deleted is still there");
});

test("deleted and then created again (a new resource) counts once", async () => {
  const { fhir, store, worker, clock } = make();
  const first = fhir.add2(quantity("p1", heartRate, 70, `${TUE}T08:00:00+00:00`));
  await worker.runOnce();
  clock.now += 60_000;
  fhir.remove(first, clock.now);
  fhir.serverNow = clock.now;
  fhir.add(quantity("p1", heartRate, 70, `${TUE}T08:00:00+00:00`));
  await worker.runOnce();
  assert.equal((await rollup(store, "heartRate"))?.n, 1);
});

test("a first run looks from now: deletions before it are not read (a rescan covers them), later ones are", async () => {
  const { fhir, store, worker, clock } = make();
  const old = fhir.add2(quantity("p1", heartRate, 70, `${TUE}T08:00:00+00:00`), T0 - 3_600_000);
  fhir.add(quantity("p1", heartRate, 80, `${TUE}T09:00:00+00:00`), T0 - 3_600_000);
  fhir.remove(old, T0 - 1_800_000); // before the worker's first run
  const first = await worker.runOnce();
  assert.equal(first.deletions, 0, "not backfilled");
  assert.equal((await rollup(store, "heartRate"))?.n, 1, "the day is right anyway: the change scan reads what the server holds now");
  clock.now += 60_000;
  const late = fhir.add2(quantity("p1", heartRate, 90, `${TUE}T10:00:00+00:00`), clock.now);
  await worker.runOnce();
  clock.now += 60_000;
  fhir.remove(late, clock.now);
  assert.equal((await worker.runOnce()).deletions, 1, "control: a deletion after the first run is read");
  assert.equal((await rollup(store, "heartRate"))?.n, 1);
});

test("a deletion whose last version cannot be read is counted, and the others still go through", async () => {
  const { fhir, store, worker, clock } = make();
  const a = fhir.add2(quantity("p1", heartRate, 60, `${TUE}T08:00:00+00:00`));
  const b = fhir.add2(quantity("p1", heartRate, 70, `${TUE}T09:00:00+00:00`));
  fhir.add(quantity("p1", heartRate, 80, `${TUE}T10:00:00+00:00`));
  await worker.runOnce();
  clock.now += 60_000;
  fhir.remove(a, clock.now);
  fhir.remove(b, clock.now);
  fhir.purged.add(`Observation/${a}/_history/1`);
  const report = await worker.runOnce();
  assert.equal(report.deletions, 2);
  assert.equal(report.deletionsUnreadable, 1);
  // the unreadable one cannot say which day it was: that day is fixed by the next full recompute (a rescan); the readable one is
  assert.equal((await rollup(store, "heartRate"))?.n, 1, "the readable deletion touched the day, and the recompute read the server's truth");
});

test("a deletion of something that is not a contract metric touches nothing", async () => {
  const { fhir, worker, clock } = make();
  const other = fhir.add2({ id: "other-1", status: "final", subject: { reference: "Patient/p1" }, code: { coding: [{ system: "http://example.org", code: "x" }] }, effectiveDateTime: `${TUE}T08:00:00+00:00` });
  await worker.runOnce();
  clock.now += 60_000;
  fhir.remove(other, clock.now);
  const report = await worker.runOnce();
  assert.equal(report.deletions, 1);
  assert.equal(report.touched, 0);
  assert.equal(report.recomputed, 0);
});

test("the deletion scan asks only for history since its own watermark, never from the beginning once it has one", async () => {
  const { fhir, worker, clock } = make();
  fhir.add(quantity("p1", heartRate, 60, `${TUE}T08:00:00+00:00`));
  await worker.runOnce();
  for (const hour of [1, 2]) {
    clock.now += 3_600_000;
    fhir.serverNow = clock.now;
    fhir.add(quantity("p1", heartRate, 60 + hour, `${TUE}T0${8 + hour}:00:00+00:00`));
    await worker.runOnce();
  }
  const asks = fhir.requests.filter((p) => p.startsWith("Observation/_history"));
  assert.equal(asks.length, 3);
  const since = asks.map((p) => Date.parse(new URL(p, "https://x.invalid/").searchParams.get("_since")!));
  assert.ok(since[2]! > since[0]!, "the third scan starts later than the first (the watermark moved on)");
  assert.ok(since[2]! >= T0 + 3_600_000 - 60_000, "and not from the beginning of the history");
});
