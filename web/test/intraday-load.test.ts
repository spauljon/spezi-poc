import { describe, expect, it } from "vitest";
import { FhirClient } from "../src/fhir/client.ts";
import type { Observation } from "../src/fhir/types.ts";
import { daySearch, loadDay } from "../src/intraday/load.ts";
import { contract, fakeHapi, metric, obs } from "./support.ts";

const DAY = "2026-09-25";
const t0 = Date.parse(`${DAY}T00:00:00Z`);
const hr = metric("heartRate");
const iso = (ms: number) => new Date(ms).toISOString();
const flag = contract.dataQualityFlag;

/** n heart-rate Observations five seconds apart from midnight, ids in time order. */
function dense(n: number, from = 0): Observation[] {
  return Array.from({ length: n }, (_, i) => {
    const t = iso(t0 + (from + i) * 5000);
    const o = obs("heartRate", 60 + (i % 20), t, t);
    o.id = `hr-${String(from + i).padStart(6, "0")}`;
    return o;
  });
}
const client = (fake: ReturnType<typeof fakeHapi>) => new FhirClient("/fhir", async () => "tok", fake as unknown as typeof fetch);

describe("daySearch", () => {
  it("asks for one UTC day of one metric, in a stable order, with only the elements the view needs", () => {
    const q = decodeURIComponent(daySearch("42", hr, contract, DAY, 2000));
    expect(q).toContain("patient=Patient/42");
    expect(q).toContain(`code=${contract.loincSystem}|${hr.loincCode}`);
    expect(q).toContain("date=ge2026-09-25T00:00:00Z");
    expect(q).toContain("date=lt2026-09-26T00:00:00Z");
    expect(q).toContain("_sort=date,_id");
    expect(q).toContain("_count=1000");
    expect(q).toContain("_offset=2000");
    expect(q).toContain("_total=accurate");
    expect(q).toContain("_elements=effectiveDateTime,effectivePeriod,valueQuantity,status,meta");
  });
});

describe("loadDay", () => {
  it("pages through the whole day by offset and gets every sample once, in time order", async () => {
    const all = dense(2500);
    const shuffled = [...all].reverse(); // the server's storage order must not matter
    const fake = fakeHapi(shuffled);
    const progress: Array<[number, number | null]> = [];
    const model = await loadDay(client(fake), "42", hr, contract, DAY, {
      now: new Date("2030-01-01T00:00:00Z"), onProgress: (l, t) => progress.push([l, t]),
    });
    expect(model.n).toBe(2500);
    expect(model.t).toEqual([...model.t].sort((a, b) => a - b));
    expect(new Set(model.t).size).toBe(2500);
    const offsets = fake.urls.map((u) => /_offset=(\d+)/.exec(u)?.[1]).filter(Boolean);
    expect(offsets).toEqual(["0", "1000", "2000"]);
    expect(progress).toEqual([[1000, 2500], [2000, 2500], [2500, 2500]]);
  });

  it("stops after one page when the day fits in it", async () => {
    const fake = fakeHapi(dense(40));
    const model = await loadDay(client(fake), "42", hr, contract, DAY, { now: new Date("2030-01-01T00:00:00Z") });
    expect(model.n).toBe(40);
    expect(fake.urls).toHaveLength(1);
  });

  it("fails the whole load when a page fails: never a partial day shown as the day", async () => {
    let calls = 0;
    const fake = fakeHapi(dense(2500), { failNetwork: () => ++calls === 2 });
    await expect(loadDay(client(fake), "42", hr, contract, DAY)).rejects.toMatchObject({ kind: "network" });
  });

  it("stops asking once it has been superseded", async () => {
    const fake = fakeHapi(dense(2500));
    let pages = 0;
    const model = await loadDay(client(fake), "42", hr, contract, DAY, {
      now: new Date("2030-01-01T00:00:00Z"), cancelled: () => pages >= 1, onProgress: () => { pages++; },
    });
    expect(fake.urls).toHaveLength(1);
    expect(model.n).toBe(1000);
  });

  it("keeps stored flags, and leaves out retracted Observations and says how many", async () => {
    const rows = dense(10);
    rows[3]!.meta = { ...rows[3]!.meta, tag: [{ system: flag.system, code: flag.artifactSuspected }] };
    rows[4]!.status = "entered-in-error";
    const model = await loadDay(client(fakeHapi(rows)), "42", hr, contract, DAY, { now: new Date("2030-01-01T00:00:00Z") });
    expect(model.n).toBe(9);
    expect(model.skipped.retracted).toBe(1);
    expect(model.flagged).toEqual([3]);
  });
});
