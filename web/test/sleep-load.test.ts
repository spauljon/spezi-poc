import { describe, expect, it } from "vitest";
import { FhirClient } from "../src/fhir/client.ts";
import type { Observation } from "../src/fhir/types.ts";
import { parseSleep, SleepShapeError } from "../src/sleep/api.ts";
import { disagreement, loadNight, nightSearch } from "../src/sleep/load.ts";
import { fakeHapi, contract } from "./support.ts";
import { KNOWN_OBSERVATIONS, KNOWN_SESSION, sessionRow } from "./sleep-fixtures.ts";

const client = (fake: ReturnType<typeof fakeHapi>) => new FhirClient("/fhir", async () => "tok", fake as unknown as typeof fetch);

describe("parseSleep", () => {
  const base = () => ({
    patientId: "1", from: "2026-09-28", to: "2026-09-28", nightDefinition: "UTC date of the final waking",
    sessions: [sessionRow()],
    completeness: { requestedDays: 1, daysWithData: 1, missingDays: [], pendingWindows: 0, lastComputedAt: null, workerWatermark: null, generatedAt: "x" },
  });

  it("accepts the documented answer and orders sessions by start", () => {
    const later = { ...sessionRow(), start: "2026-09-28T21:00:00Z", end: "2026-09-28T21:40:00Z", isMain: false };
    const r = parseSleep({ ...base(), sessions: [later, sessionRow()] });
    expect(r.sessions.map((s) => s.isMain)).toEqual([true, false]);
  });

  it.each([
    ["not an object", 3],
    ["no sessions list", { ...base(), sessions: undefined }],
    ["a session without a night", { ...base(), sessions: [{ ...sessionRow(), night: "soon" }] }],
    ["a session with a missing number", { ...base(), sessions: [{ ...sessionRow(), deepMin: undefined }] }],
    ["a session that ends before it starts", { ...base(), sessions: [{ ...sessionRow(), end: "2026-09-27T00:00:00Z" }] }],
    ["no completeness", { ...base(), completeness: undefined }],
  ])("rejects %s", (_n, body) => {
    expect(() => parseSleep(body)).toThrow(SleepShapeError);
  });
});

describe("nightSearch and loadNight", () => {
  it("asks for the five stage codes in the session's window, in a stable order", () => {
    const q = decodeURIComponent(nightSearch("42", contract, { start: "2026-09-28T05:30:00.000Z", end: "2026-09-28T13:30:00.000Z" }, 200));
    for (const s of contract.sleepStages) expect(q).toContain(`${contract.loincSystem}|${s.loincCode}`);
    expect(q).toContain("date=ge2026-09-28T05:30:00.000Z");
    expect(q).toContain("date=lt2026-09-28T13:30:00.000Z");
    expect(q).toContain("_sort=date,_id");
    expect(q).toContain("_offset=200");
  });

  it("reads the night, resolves it, and its statistics equal the analytic summary (control: a different summary does not)", async () => {
    const model = await loadNight(client(fakeHapi(KNOWN_OBSERVATIONS)), "1", contract, KNOWN_SESSION);
    expect(model.intervals).toHaveLength(13);
    expect(model.stats!.asleepMin).toBe(397);
    expect(disagreement(model.stats!, KNOWN_SESSION)).toBeNull();
    expect(disagreement(model.stats!, { ...KNOWN_SESSION, awakenings: 2 })).toEqual({ field: "awakenings", web: 1, api: 2 });
    expect(disagreement(model.stats!, { ...KNOWN_SESSION, overlapMin: 0 })).toMatchObject({ field: "overlapMin" });
  });

  it("leaves out a neighbouring session's intervals (positive control: a nap on the same date is not in the night)", async () => {
    const nap: Observation = { ...KNOWN_OBSERVATIONS[0]!, id: "nap", effectivePeriod: { start: "2026-09-28T21:00:00+00:00", end: "2026-09-28T21:40:00+00:00" } };
    const model = await loadNight(client(fakeHapi([...KNOWN_OBSERVATIONS, nap])), "1", contract, KNOWN_SESSION);
    expect(model.intervals.map((i) => i.id)).not.toContain("nap");
    expect(model.intervals).toHaveLength(13);
  });

  it("excludes an interval that only TOUCHES the window, which HAPI's overlap matching returns (control: the interior is kept)", async () => {
    const touching = (id: string, start: string, end: string): Observation => ({ ...KNOWN_OBSERVATIONS[1]!, id, effectivePeriod: { start, end } });
    const before = touching("before", "2026-09-28T04:30:00+00:00", "2026-09-28T05:30:00+00:00"); // ends exactly at the session start
    const after = touching("after", "2026-09-28T13:30:00+00:00", "2026-09-28T14:00:00+00:00"); // starts exactly at the session end
    const everything = [before, ...KNOWN_OBSERVATIONS, after];
    // a server that returns every one of them, as an overlap match could
    const fetchAll = (async () => new Response(JSON.stringify({ resourceType: "Bundle", type: "searchset", total: everything.length, entry: everything.map((resource) => ({ resource })) }), { status: 200 })) as unknown as typeof fetch;
    const model = await loadNight(new FhirClient("/fhir", async () => "tok", fetchAll), "1", contract, KNOWN_SESSION);
    expect(model.intervals.map((i) => i.id)).not.toContain("before");
    expect(model.intervals.map((i) => i.id)).not.toContain("after");
    expect(model.intervals).toHaveLength(13);
  });

  it("counts what it cannot use", async () => {
    const retracted: Observation = { ...KNOWN_OBSERVATIONS[1]!, id: "r", status: "entered-in-error" };
    const model = await loadNight(client(fakeHapi([...KNOWN_OBSERVATIONS, retracted])), "1", contract, KNOWN_SESSION);
    expect(model.skipped.retracted).toBe(1);
    expect(model.intervals).toHaveLength(13);
  });

  it("fails the whole load when the server fails (never a part of a night)", async () => {
    const fake = fakeHapi(KNOWN_OBSERVATIONS, { status: 500 });
    await expect(loadNight(client(fake), "1", contract, KNOWN_SESSION)).rejects.toMatchObject({ kind: "server" });
  });
});
