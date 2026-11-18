import type { Contract } from "./contract.ts";
import type { Store, Window } from "./store.ts";
import { windowKey } from "./store.ts";

/**
 * Every window the store already holds a row for: a daily rollup, a sleep night, a dietary day. A rescan marks these as pending
 * as well as resetting the watermark, because re-reading what the server holds (the watermark reset) can only touch a window
 * that still has an Observation: a window whose samples were ALL deleted (HAPI deletes softly, M29) would keep its old row
 * forever. Recomputing each from the server's current data drops it.
 */
export async function storedWindows(store: Store, contract: Contract): Promise<Window[]> {
  const windows = new Map<string, Window>();
  const add = (w: Window) => windows.set(windowKey(w), w);
  for (const r of await store.rollups()) {
    add({ patientId: r.patientId, metricId: r.metricId, day: r.day });
  }
  if (contract.sleep) {
    for (const n of await store.nights()) {
      add({ patientId: n.patientId, metricId: contract.sleep.id, day: n.night });
    }
  }
  for (const t of await store.intakeTotals()) {
    add({ patientId: t.patientId, metricId: t.metricId, day: t.day });
  }
  return [...windows.values()];
}

/** The whole rescan: forget the watermark (re-read everything that exists) and mark every stored window (drop what no longer exists). */
export async function requestRescan(store: Store, contract: Contract, worker: string): Promise<number> {
  await store.resetWatermark(worker);
  const windows = await storedWindows(store, contract);
  await store.recordTouched(worker, windows, null);
  return windows.length;
}
