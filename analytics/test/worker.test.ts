import assert from "node:assert/strict";
import { test } from "node:test";
import { RollupWorker, patientIdOf } from "../src/worker.ts";
import type { Rollup, Store, Window } from "../src/store.ts";
import { MemoryStore } from "../src/store.ts";
import { FakeFhir, contract, heartRate, hrv, quantity } from "./support.ts";

const TUE = "2026-10-06";
const WED = "2026-10-07";
const THU = "2026-10-08";

function make(fhir = new FakeFhir(), store: Store = new MemoryStore(), overlapMs?: number) {
  const worker = new RollupWorker({ name: "t", contract, fhir, store, ...(overlapMs === undefined ? {} : { overlapMs }) });
  return { fhir, store, worker };
}

const rows = async (store: Store) => (await store.rollups()).map((r) => ({ ...r }));

test("rolls up count, min, median and max per patient, metric and UTC day", async () => {
  const { fhir, store, worker } = make();
  for (const [value, at] of [[60, `${TUE}T08:00:00+00:00`], [80, `${TUE}T09:00:00+00:00`], [70, `${TUE}T10:00:00+00:00`]] as const) {
    fhir.add(quantity("p1", heartRate, value, at));
  }
  fhir.add(quantity("p1", heartRate, 90, `${WED}T09:00:00+00:00`));
  fhir.add(quantity("p1", hrv, 41, `${TUE}T09:00:00+00:00`));
  fhir.add(quantity("p2", heartRate, 55, `${TUE}T09:00:00+00:00`));

  const report = await worker.runOnce();
  assert.equal(report.scanned, 6);
  assert.equal(report.changed, 4);
  const byKey = new Map((await store.rollups()).map((r) => [`${r.patientId}|${r.metricId}|${r.day}`, r]));
  assert.deepEqual(
    { ...byKey.get(`p1|heartRate|${TUE}`) },
    { patientId: "p1", metricId: "heartRate", day: TUE, unit: heartRate.ucum, n: 3, min: 60, median: 70, max: 80, revision: 1 },
  );
  assert.equal(byKey.get(`p1|heartRate|${WED}`)?.n, 1);
  assert.equal(byKey.get(`p1|hrvSdnn|${TUE}`)?.unit, hrv.ucum);
  assert.equal(byKey.get(`p2|heartRate|${TUE}`)?.max, 55);
  assert.equal(byKey.size, 4);
});

test("the day is the UTC day of the instant, whatever offset the sample carries", async () => {
  const { fhir, store, worker } = make();
  // 22:30 on the 6th at -05:00 is 03:30 on the 7th UTC; 20:00 on the 6th at -04:00 is 00:00 on the 7th UTC (boundary)
  fhir.add(quantity("p1", heartRate, 61, `${TUE}T22:30:00-05:00`));
  fhir.add(quantity("p1", heartRate, 62, `${TUE}T20:00:00-04:00`));
  fhir.add(quantity("p1", heartRate, 63, `${TUE}T19:59:59-04:00`)); // 23:59:59 UTC on the 6th
  await worker.runOnce();
  const r = await rows(store);
  assert.deepEqual(r.map((x) => [x.day, x.n]), [[TUE, 1], [WED, 2]]);
});

test("running again changes nothing: rows, revisions and counts are identical", async () => {
  const { fhir, store, worker } = make();
  for (let i = 0; i < 10; i++) {
    fhir.add(quantity("p1", heartRate, 60 + i, `${TUE}T0${i}:00:00+00:00`));
  }
  await worker.runOnce();
  const first = await rows(store);
  const again = await worker.runOnce(); // overlap makes it re-read everything, so recompute really happens
  assert.ok(again.recomputed > 0, "the second run must re-read and recompute, or this test proves nothing");
  assert.equal(again.changed, 0);
  assert.deepEqual(await rows(store), first);
});

test("a late Tuesday sample delivered Thursday changes only Tuesday's row", async () => {
  const { fhir, store, worker } = make();
  const tue = Date.parse(`${TUE}T12:00:00Z`), wed = Date.parse(`${WED}T12:00:00Z`), thu = Date.parse(`${THU}T12:00:00Z`);
  fhir.add(quantity("p1", heartRate, 60, `${TUE}T08:00:00+00:00`), tue);
  fhir.add(quantity("p1", heartRate, 70, `${TUE}T09:00:00+00:00`), tue);
  fhir.add(quantity("p1", heartRate, 65, `${WED}T08:00:00+00:00`), wed);
  fhir.serverNow = wed;
  await worker.runOnce();
  const before = await rows(store);

  // Thursday: the phone delivers a sample it measured on Tuesday
  fhir.add(quantity("p1", heartRate, 120, `${TUE}T23:00:00+00:00`), thu);
  const report = await worker.runOnce();

  const after = await rows(store);
  assert.equal(report.changed, 1);
  const changed = after.filter((r, i) => JSON.stringify(r) !== JSON.stringify(before[i]));
  assert.deepEqual(changed.map((r) => r.day), [TUE]);
  const tuesday = after.find((r) => r.day === TUE)!;
  assert.deepEqual([tuesday.n, tuesday.max, tuesday.revision], [3, 120, 2]);
  assert.equal(after.find((r) => r.day === WED)!.revision, 1);
});

test("a resource that arrives twice in one search (paging overlap) counts once", async () => {
  const fhir = new FakeFhir();
  const original = fhir.search.bind(fhir);
  fhir.search = async function* (path: string) {
    for await (const r of original(path)) {
      yield r;
      yield r; // the same resource again
    }
  };
  const { store, worker } = make(fhir);
  fhir.add(quantity("p1", heartRate, 60, `${TUE}T08:00:00+00:00`));
  fhir.add(quantity("p1", heartRate, 80, `${TUE}T09:00:00+00:00`));
  await worker.runOnce();
  assert.equal((await rows(store))[0]!.n, 2);
});

test("a sample that becomes visible slightly behind the watermark is still found (overlap), one far behind is not", async () => {
  const base = Date.parse("2026-10-12T12:00:00.000Z");
  const { fhir, store, worker } = make(new FakeFhir(), new MemoryStore(), 60_000);
  fhir.add(quantity("p1", heartRate, 60, `${TUE}T08:00:00+00:00`), base);
  await worker.runOnce(); // watermark = base

  // a transaction that started 30 s before `base` but committed after it
  fhir.add(quantity("p1", heartRate, 70, `${TUE}T09:00:00+00:00`), base - 30_000);
  await worker.runOnce();
  assert.equal((await rows(store))[0]!.n, 2, "inside the overlap it must be found");

  // one stamped 10 minutes behind the watermark, on a day nothing else touches: outside the overlap it is, by design,
  // not seen until something touches that day (positive control for the case above)
  fhir.add(quantity("p1", heartRate, 80, `${WED}T10:00:00+00:00`), base - 600_000);
  await worker.runOnce();
  assert.deepEqual((await rows(store)).map((r) => r.day), [TUE]);
});

test("observations in another unit are left out and counted", async () => {
  const { fhir, store, worker } = make();
  fhir.add(quantity("p1", heartRate, 60, `${TUE}T08:00:00+00:00`));
  fhir.add(quantity("p1", heartRate, 5000, `${TUE}T09:00:00+00:00`, {
    valueQuantity: { value: 5000, system: contract.ucumSystem, code: "mm[Hg]" },
  }));
  const report = await worker.runOnce();
  assert.equal(report.wrongUnit, 1);
  const r = (await rows(store))[0]!;
  assert.deepEqual([r.n, r.max], [1, 60]);
});

test("only the contract's quantity metrics are asked for (sleep stages are not rolled up here)", async () => {
  const { fhir, worker } = make();
  await worker.runOnce();
  const scan = decodeURIComponent(fhir.requests[0]!);
  for (const m of contract.quantityMetrics) {
    assert.ok(scan.includes(`${contract.loincSystem}|${m.loincCode}`), `${m.id} missing from the scan`);
  }
  const requested = (scan.match(/code=([^&]*)/)![1]!).split(",");
  assert.equal(requested.length, contract.quantityMetrics.length);
});

test("an observation with no usable subject, code or time is ignored, not fatal", async () => {
  const { fhir, store, worker } = make();
  fhir.add(quantity("p1", heartRate, 60, `${TUE}T08:00:00+00:00`));
  fhir.add(quantity("p1", heartRate, 61, "garbage"));
  fhir.add({ ...quantity("p1", heartRate, 62, `${TUE}T09:00:00+00:00`), subject: { reference: "Group/9" } });
  const report = await worker.runOnce();
  assert.equal(report.ignored, 2);
  assert.equal((await rows(store)).length, 1);
});

test("an interrupted cycle loses nothing: touched windows survive and finish on the next run", async () => {
  class FailsOnce extends MemoryStore {
    failed = false;
    override async applyRollup(window: Window, rollup: Rollup | null): Promise<boolean> {
      if (!this.failed) {
        this.failed = true;
        throw new Error("simulated crash while writing");
      }
      return super.applyRollup(window, rollup);
    }
  }
  const store = new FailsOnce();
  const { fhir, worker } = make(new FakeFhir(), store);
  fhir.add(quantity("p1", heartRate, 60, `${TUE}T08:00:00+00:00`));
  fhir.add(quantity("p1", heartRate, 70, `${WED}T08:00:00+00:00`));

  await assert.rejects(worker.runOnce(), /simulated crash/);
  assert.notEqual(await store.getWatermark("t"), null, "the watermark advanced with the touched windows");
  assert.equal((await store.pendingWindows(10)).length, 2, "both windows still pending");

  // nothing new on the server (overlap 0 so the scan itself finds nothing): the pending windows alone complete the work
  const resume = new RollupWorker({ name: "t", contract, fhir, store, overlapMs: 0 });
  fhir.serverNow += 1;
  await resume.runOnce();
  assert.equal((await store.pendingWindows(10)).length, 0);
  assert.equal((await store.rollups()).length, 2);
});

test("a window whose observations vanished removes its rollup", async () => {
  const { fhir, store, worker } = make();
  fhir.add(quantity("p1", heartRate, 60, `${TUE}T08:00:00+00:00`));
  await worker.runOnce();
  assert.equal((await store.rollups()).length, 1);
  await store.recordTouched("t", [{ patientId: "p1", metricId: "heartRate", day: TUE }], null);
  (fhir as unknown as { resources: unknown[] }).resources.length = 0;
  await worker.runOnce();
  assert.equal((await store.rollups()).length, 0);
});

test("patientIdOf accepts Patient references only", () => {
  assert.equal(patientIdOf("Patient/42"), "42");
  assert.equal(patientIdOf("https://h/fhir/Patient/abc-1"), "abc-1");
  assert.equal(patientIdOf("Group/42"), null);
  assert.equal(patientIdOf("Patient/"), null);
  assert.equal(patientIdOf(undefined), null);
});
