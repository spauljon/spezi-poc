import { describe, expect, it } from "vitest";
import { OBSERVATION_STATUSES, SORT_COLUMNS, buildSearch, defaultQuery, flowMetrics, validateQuery, type FlowQuery } from "../src/flowsheet/query.ts";
import { toRow } from "../src/flowsheet/rows.ts";
import { contract, obs, sleepObs } from "./support.ts";

const q = (patch: Partial<FlowQuery> = {}): FlowQuery => ({ ...defaultQuery, ...patch });
const decoded = (s: string) => decodeURIComponent(s);

describe("buildSearch", () => {
  it("defaults: every contract metric, newest first, deterministic tie-break, first page, accurate total", () => {
    const s = decoded(buildSearch(q(), "42", contract));
    expect(s.startsWith("Observation?patient=Patient/42&code=")).toBe(true);
    for (const m of flowMetrics(contract)) {
      expect(s).toContain(`${contract.loincSystem}|${m.code}`);
    }
    expect(s).toContain("_sort=-date,_id");
    expect(s).toContain("_count=25");
    expect(s).toContain("_offset=0");
    expect(s).toContain("_total=accurate");
    expect(s).not.toContain("status=");
    expect(s).not.toContain("_source=");
    expect(s).not.toMatch(/date=(ge|lt)/);
  });

  it("the code list is exactly the chosen metrics, from the contract", () => {
    const s = decoded(buildSearch(q({ metrics: ["heartRate", "asleepDeep"] }), "42", contract));
    const codes = /code=([^&]*)/.exec(s)![1]!.split(",");
    const hr = contract.quantityMetrics.find((m) => m.id === "heartRate")!;
    const deep = contract.sleepStages.find((x) => x.id === "asleepDeep")!;
    expect(codes).toEqual([`${contract.loincSystem}|${hr.loincCode}`, `${contract.loincSystem}|${deep.loincCode}`]);
  });

  it("the date range is UTC, inclusive of the end day (the next midnight is the exclusive bound)", () => {
    const s = decoded(buildSearch(q({ from: "2026-10-01", to: "2026-10-31" }), "42", contract));
    expect(s).toContain("date=ge2026-10-01T00:00:00Z");
    expect(s).toContain("date=lt2026-11-01T00:00:00Z");
    expect(decoded(buildSearch(q({ to: "2026-12-31" }), "42", contract))).toContain("date=lt2027-01-01T00:00:00Z");
    expect(decoded(buildSearch(q({ to: "2028-02-28" }), "42", contract))).toContain("date=lt2028-02-29T00:00:00Z");
  });

  it("source filters use the contract's meta.source URL; status is passed through", () => {
    const s = decoded(buildSearch(q({ source: "healthKit", status: "preliminary" }), "42", contract));
    expect(s).toContain(`_source=${contract.metaSource.healthKit}`);
    expect(s).toContain("status=preliminary");
  });

  it("every sortable column maps to a server parameter, both directions, always ending in _id", () => {
    const expected: Record<string, string> = {
      measured: "date", metric: "code", value: "value-quantity", status: "status", received: "_lastUpdated",
    };
    expect(SORT_COLUMNS.sort()).toEqual(Object.keys(expected).sort());
    for (const column of SORT_COLUMNS) {
      for (const [direction, sign] of [["asc", ""], ["desc", "-"]] as const) {
        const s = decoded(buildSearch(q({ sort: { column, direction } }), "42", contract));
        expect(s).toContain(`_sort=${sign}${expected[column]},_id`);
      }
    }
  });

  it("paging is an offset of page x size", () => {
    expect(buildSearch(q({ page: 3, pageSize: 50 }), "42", contract)).toContain("_offset=150");
    expect(buildSearch(q({ page: 3, pageSize: 50 }), "42", contract)).toContain("_count=50");
  });

  it("the patient reference is escaped", () => {
    expect(buildSearch(q(), "a/b c", contract)).toContain("patient=Patient%2Fa%2Fb%20c");
  });
});

describe("validateQuery", () => {
  it("accepts none, one or both ends, equal days included", () => {
    expect(validateQuery(q())).toBeNull();
    expect(validateQuery(q({ from: "2026-10-01" }))).toBeNull();
    expect(validateQuery(q({ from: "2026-10-01", to: "2026-10-01" }))).toBeNull();
  });
  it("refuses an inverted or malformed range", () => {
    expect(validateQuery(q({ from: "2026-10-02", to: "2026-10-01" }))).toMatch(/after/);
    expect(validateQuery(q({ from: "2026-13-01" }))).toMatch(/start date/);
    expect(validateQuery(q({ to: "yesterday" }))).toMatch(/end date/);
  });
  it("the status list is the R4 Observation status value set", () => {
    expect([...OBSERVATION_STATUSES].sort()).toEqual(
      ["amended", "cancelled", "corrected", "entered-in-error", "final", "preliminary", "registered", "unknown"]);
  });
});

describe("toRow", () => {
  it("a quantity: contract display and unit, value, source, status, receipt", () => {
    const r = toRow(obs("heartRate", 72.5, "2026-10-12T10:00:00+00:00", "2026-10-12T10:00:03.000+00:00"), contract);
    const hr = contract.quantityMetrics.find((m) => m.id === "heartRate")!;
    expect(r).toMatchObject({ metric: hr.display, unit: hr.unit, value: 72.5, known: true, source: "synthetic",
      measured: "2026-10-12T10:00:00+00:00", measuredEnd: null, unitMismatch: null, received: "2026-10-12T10:00:03.000+00:00" });
  });

  it("a sleep stage: the stage's display, its period, and minutes", () => {
    const stage = contract.sleepStages[0]!;
    const r = toRow(sleepObs(stage.loincCode, "2026-10-12T02:00:00.000+00:00"), contract);
    expect(r.metric).toBe(stage.display);
    expect(r.unit).toBe(contract.sleepUnit);
    expect(r.measuredEnd).toBe("2026-10-12T02:00:00+00:00");
  });

  it("an unknown code is kept and labelled, never dropped or mapped to something else", () => {
    const o = obs("heartRate", 70, "2026-10-12T10:00:00+00:00", "2026-10-12T10:00:03.000+00:00");
    o.code = { coding: [{ system: contract.loincSystem, code: "0000-0" }] };
    const r = toRow(o, contract);
    expect(r.known).toBe(false);
    expect(r.metric).toBe("Unknown code 0000-0");
  });

  it("a unit that is not the contract's is reported, not corrected", () => {
    const o = obs("heartRate", 70, "2026-10-12T10:00:00+00:00", "2026-10-12T10:00:03.000+00:00");
    o.valueQuantity = { value: 70, code: "mm[Hg]" };
    const r = toRow(o, contract);
    expect(r.unit).toBe(contract.quantityMetrics.find((m) => m.id === "heartRate")!.unit);
    expect(r.unitMismatch).toBe("mm[Hg]");
  });

  it("missing value, status and source are explicit", () => {
    const o = obs("heartRate", 70, "2026-10-12T10:00:00+00:00", "x", "http://elsewhere.example");
    delete o.valueQuantity;
    delete o.status;
    const r = toRow(o, contract);
    expect(r).toMatchObject({ value: null, status: "unknown", source: "unknown" });
  });
});
