import assert from "node:assert/strict";
import { test } from "node:test";
import { requestRescan, storedWindows } from "../src/rescan.ts";
import { MemoryStore } from "../src/store.ts";
import { RollupWorker } from "../src/worker.ts";
import { FakeFhir, contract, heartRate, intake, energy, quantity, sleepStage } from "./support.ts";

const D = "2026-10-06";

/** A rescan re-reads what exists AND recomputes what the store holds, so a window whose samples were all deleted is dropped (M29). */
test("a window whose samples were all deleted is dropped by a rescan, and one that still has data is kept", async () => {
  const fhir = new FakeFhir();
  const store = new MemoryStore();
  const worker = new RollupWorker({ name: "w", contract, fhir, store, now: () => fhir.serverNow });
  const gone = fhir.add2(quantity("p1", heartRate, 70, `${D}T08:00:00+00:00`));
  fhir.add(quantity("p1", heartRate, 80, "2026-10-07T08:00:00+00:00"));
  const meal = fhir.add2(intake("p1", energy, 500, `${D}T12:00:00+00:00`, { meal: "lunch" }));
  const stage = fhir.add2(sleepStage("p1", "asleepDeep", `${D}T02:00:00Z`, `${D}T03:00:00Z`));
  await worker.runOnce();
  assert.equal((await store.rollups()).length, 2);
  assert.ok((await store.nights()).length >= 1 && (await store.intakeTotals()).length >= 1);

  // the deletions happen while no worker is watching (before the deletion scan existed): nothing marks those windows
  const before = fhir.serverNow - 600_000; // older than the history watermark the first run set: the scan never looks that far back
  fhir.remove(gone, before); fhir.remove(meal, before); fhir.remove(stage, before);
  await worker.runOnce();
  assert.equal((await store.rollups()).length, 2, "control: without a rescan the stale rows stay (nothing marks a window with no live sample)");

  const windows = await storedWindows(store, contract);
  assert.ok(windows.length >= 4, `every stored window is named (${windows.length})`);
  assert.equal(await requestRescan(store, contract, "w"), windows.length);
  await worker.runOnce();
  const rows = await store.rollups();
  assert.deepEqual(rows.map((r) => r.day), ["2026-10-07"], "the day that lost all its samples is gone, the other stays");
  assert.equal((await store.intakeTotals()).length, 0, "the dietary day is gone");
  assert.equal((await store.nights()).length, 0, "the sleep night is gone");
});
