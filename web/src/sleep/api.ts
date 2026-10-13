import type { Completeness } from "../trends/model.ts";

export interface SleepSession {
  readonly night: string;
  readonly isMain: boolean;
  readonly start: string;
  readonly end: string;
  readonly onset: string;
  readonly finalWaking: string;
  readonly asleepMin: number;
  readonly coreMin: number;
  readonly deepMin: number;
  readonly remMin: number;
  readonly unspecifiedMin: number;
  readonly awakeMin: number;
  readonly latencyMin: number;
  readonly wakeAfterEndMin: number;
  readonly unscoredMin: number;
  readonly overlapMin: number;
  readonly awakenings: number;
  readonly intervalCount: number;
  readonly revision: number;
}

export interface SleepResponse {
  readonly patientId: string;
  readonly from: string;
  readonly to: string;
  readonly nightDefinition: string;
  readonly sessions: readonly SleepSession[];
  readonly completeness: Completeness;
}

export class SleepShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SleepShapeError";
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
const isInstant = (v: unknown): v is string => typeof v === "string" && !Number.isNaN(Date.parse(v));
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

const NUMERIC = [
  "asleepMin", "coreMin", "deepMin", "remMin", "unspecifiedMin", "awakeMin", "latencyMin", "wakeAfterEndMin", "unscoredMin",
  "overlapMin", "awakenings", "intervalCount", "revision",
] as const;

/** Validates the documented answer rather than casting it: a response of another shape is an error, not a chart. */
export function parseSleep(raw: unknown): SleepResponse {
  if (!isRecord(raw)) throw new SleepShapeError("The response is not an object.");
  const { patientId, from, to, nightDefinition, sessions, completeness } = raw;
  if (typeof patientId !== "string" || !isDay(from) || !isDay(to) || typeof nightDefinition !== "string") {
    throw new SleepShapeError("The response header is malformed.");
  }
  if (!Array.isArray(sessions)) throw new SleepShapeError("sessions is not a list.");
  if (!isRecord(completeness) || !num(completeness["requestedDays"]) || !num(completeness["daysWithData"])
      || !Array.isArray(completeness["missingDays"]) || !num(completeness["pendingWindows"])) {
    throw new SleepShapeError("completeness is malformed.");
  }
  const parsed = sessions.map((item: unknown): SleepSession => {
    if (!isRecord(item) || !isDay(item["night"]) || typeof item["isMain"] !== "boolean"
        || !isInstant(item["start"]) || !isInstant(item["end"]) || !isInstant(item["onset"]) || !isInstant(item["finalWaking"])) {
      throw new SleepShapeError("a session is malformed.");
    }
    for (const k of NUMERIC) if (!num(item[k])) throw new SleepShapeError(`a session has no usable ${k}.`);
    if (Date.parse(item["end"] as string) <= Date.parse(item["start"] as string)) throw new SleepShapeError("a session ends before it starts.");
    const n = item as Record<string, number | string | boolean>;
    return {
      night: n["night"] as string, isMain: n["isMain"] as boolean, start: n["start"] as string, end: n["end"] as string,
      onset: n["onset"] as string, finalWaking: n["finalWaking"] as string,
      asleepMin: n["asleepMin"] as number, coreMin: n["coreMin"] as number, deepMin: n["deepMin"] as number, remMin: n["remMin"] as number,
      unspecifiedMin: n["unspecifiedMin"] as number, awakeMin: n["awakeMin"] as number, latencyMin: n["latencyMin"] as number,
      wakeAfterEndMin: n["wakeAfterEndMin"] as number, unscoredMin: n["unscoredMin"] as number, overlapMin: n["overlapMin"] as number,
      awakenings: n["awakenings"] as number, intervalCount: n["intervalCount"] as number, revision: n["revision"] as number,
    };
  });
  const c = completeness;
  return {
    patientId, from, to, nightDefinition,
    sessions: parsed.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)),
    completeness: {
      requestedDays: c["requestedDays"] as number,
      daysWithData: c["daysWithData"] as number,
      missingDays: (c["missingDays"] as unknown[]).filter(isDay),
      pendingWindows: c["pendingWindows"] as number,
      lastComputedAt: typeof c["lastComputedAt"] === "string" ? c["lastComputedAt"] : null,
      workerWatermark: typeof c["workerWatermark"] === "string" ? c["workerWatermark"] : null,
      generatedAt: typeof c["generatedAt"] === "string" ? c["generatedAt"] : "",
    },
  };
}
