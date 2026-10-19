import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One quantity metric the worker rolls up, exactly as `contract/metrics.json` states it. */
export interface QuantityMetric {
  readonly id: string;
  readonly loincCode: string;
  readonly ucum: string;
  /** LOINC display text, for UIs. */
  readonly display: string;
}

/** The sleep-stage metric: one duration Observation per stage interval, code per stage. */
export interface SleepMetric {
  readonly id: string;
  /** LOINC code -> contract stage id (`asleepCore`, `awake`, ...). */
  readonly stageByCode: ReadonlyMap<string, string>;
  /** Stage ids the contract says have no Observation (`inBed`). */
  readonly unmapped: readonly string[];
}

/** The data-quality flags written into `Observation.meta.tag` (contract `systems.dataQualityFlag`, `dataQualityFlags`). */
export interface QualityFlags {
  readonly system: string;
  readonly artifactSuspected: string;
  readonly lateArrival: string;
}

export interface Contract {
  readonly version: string;
  readonly flags: QualityFlags;
  readonly loincSystem: string;
  readonly ucumSystem: string;
  readonly quantityMetrics: readonly QuantityMetric[];
  readonly sleep: SleepMetric | null;
}

export const SUPPORTED_MAJOR = 1;

export const defaultContractPath = fileURLToPath(new URL("../../contract/metrics.json", import.meta.url));

interface RawMetric {
  id?: unknown;
  kind?: unknown;
  loinc?: { code?: unknown; display?: unknown };
  unit?: { ucum?: unknown };
  stages?: Record<string, { code?: unknown }>;
  unmapped?: unknown;
}

/** A string field, or "" when absent or not a string (never "[object Object]"). */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function parseSleep(metric: RawMetric): SleepMetric {
  const stageByCode = new Map<string, string>();
  for (const [stage, coding] of Object.entries(metric.stages ?? {})) {
    const code = text(coding.code);
    if (!code) {
      throw new Error(`contract sleep stage ${stage} lacks a code`);
    }
    stageByCode.set(code, stage);
  }
  if (stageByCode.size === 0) {
    throw new Error("contract sleep metric has no stages");
  }
  const unmapped = Array.isArray(metric.unmapped) ? metric.unmapped.map(text) : [];
  return { id: text(metric.id), stageByCode, unmapped };
}

function parseQuantity(metric: RawMetric): QuantityMetric {
  const id = text(metric.id);
  const loincCode = text(metric.loinc?.code);
  const ucum = text(metric.unit?.ucum);
  if (!id || !loincCode || !ucum) {
    throw new Error(`contract metric ${id || "(no id)"} lacks a code or unit`);
  }
  return { id, loincCode, ucum, display: text(metric.loinc?.display) || id };
}

/**
 * Reads the contract and keeps only what the rollups need. Nothing here is a literal: a code or unit that is not in
 * the file does not exist for the worker (spec: never hand-copy codes, units or categories).
 */
export function loadContract(path: string = defaultContractPath): Contract {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    contractVersion?: unknown;
    systems?: { loinc?: unknown; ucum?: unknown; dataQualityFlag?: unknown };
    dataQualityFlags?: { artifactSuspected?: unknown; lateArrival?: unknown };
    metrics?: RawMetric[];
  };
  const version = text(raw.contractVersion);
  if (Number(version.split(".")[0]) !== SUPPORTED_MAJOR) {
    throw new Error(`contract version ${version} is not supported (this worker supports major ${SUPPORTED_MAJOR})`);
  }
  const loincSystem = text(raw.systems?.loinc);
  const ucumSystem = text(raw.systems?.ucum);
  if (!loincSystem || !ucumSystem) {
    throw new Error("contract has no LOINC or UCUM system");
  }
  const flags: QualityFlags = {
    system: text(raw.systems?.dataQualityFlag),
    artifactSuspected: text(raw.dataQualityFlags?.artifactSuspected),
    lateArrival: text(raw.dataQualityFlags?.lateArrival),
  };
  if (!flags.system || !flags.artifactSuspected || !flags.lateArrival) {
    throw new Error("contract has no data-quality flags (contract 1.4.0 or later is required)");
  }
  const metrics = raw.metrics ?? [];
  // an unknown kind is not rolled up
  const quantityMetrics = metrics.filter((m) => m.kind === "quantity").map(parseQuantity);
  const sleepMetric = metrics.find((m) => m.kind === "sleepStage");
  if (quantityMetrics.length === 0) {
    throw new Error("contract has no quantity metrics");
  }
  return { version, flags, loincSystem, ucumSystem, quantityMetrics, sleep: sleepMetric ? parseSleep(sleepMetric) : null };
}
