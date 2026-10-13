import type { Observation } from "../src/fhir/types.ts";
import type { SleepSession } from "../src/sleep/api.ts";
import { contract, type SleepRow } from "./support.ts";

const code = (stage: string) => contract.sleepStages.find((s) => s.id === stage)!.loincCode;
const stageObs = (id: string, stage: string, start: string, end: string): Observation => ({
  resourceType: "Observation", id, status: "final",
  code: { coding: [{ system: contract.loincSystem, code: code(stage) }] },
  effectivePeriod: { start, end }, valueQuantity: { value: 1, unit: "min" },
});
const d = (hhmm: string, day = "2026-09-28") => `${day}T${hhmm}:00+00:00`;

/** The "known night" of web/tools/seed-sleep-nights.mjs (instants as UTC here; offsets are tested separately). */
export const KNOWN_OBSERVATIONS: Observation[] = [
  ["awake", "05:30", "06:00"], ["asleepCore", "06:00", "06:45"], ["asleepDeep", "06:45", "07:30"], ["asleepCore", "07:30", "08:00"],
  ["awake", "08:00", "08:03"], ["asleepREM", "08:03", "09:00"], ["asleepCore", "09:00", "09:20"], ["asleepUnspecified", "09:10", "09:40"],
  ["asleepDeep", "09:50", "10:20"], ["awake", "10:20", "10:30"], ["asleepCore", "10:30", "12:00"], ["asleepREM", "12:00", "13:00"],
  ["awake", "13:00", "13:30"],
].map(([stage, a, b], i) => stageObs(`k${String(i).padStart(2, "0")}`, stage!, d(a!), d(b!)));

/** What the analytic worker reports for it (hand-computed; the live test compares the real API with the same). */
export const sessionRow = (over: Partial<SleepRow> = {}): SleepRow => ({
  night: "2026-09-28", isMain: true, start: "2026-09-28T05:30:00.000Z", end: "2026-09-28T13:30:00.000Z",
  onset: "2026-09-28T06:00:00.000Z", finalWaking: "2026-09-28T13:00:00.000Z",
  asleepMin: 397, coreMin: 175, deepMin: 75, remMin: 117, unspecifiedMin: 30, awakeMin: 13, latencyMin: 30, wakeAfterEndMin: 30,
  unscoredMin: 10, overlapMin: 10, awakenings: 1, intervalCount: 13, revision: 1, ...over,
});
export const KNOWN_SESSION: SleepSession = { ...sessionRow(), revision: 1 };
