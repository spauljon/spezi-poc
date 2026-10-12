import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One quantity metric the worker rolls up, exactly as `contract/metrics.json` states it. */
export interface QuantityMetric {
  readonly id: string;
  readonly loincCode: string;
  readonly ucum: string;
}

/** The sleep-stage metric: one duration Observation per stage interval, code per stage. */
export interface SleepMetric {
  readonly id: string;
  /** LOINC code -> contract stage id (`asleepCore`, `awake`, ...). */
  readonly stageByCode: ReadonlyMap<string, string>;
  /** Stage ids the contract says have no Observation (`inBed`). */
  readonly unmapped: readonly string[];
}

export interface Contract {
  readonly version: string;
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
  loinc?: { code?: unknown };
  unit?: { ucum?: unknown };
  stages?: Record<string, { code?: unknown }>;
  unmapped?: unknown;
}

/**
 * Reads the contract and keeps only what the rollups need. Nothing here is a literal: a code or unit that is not in
 * the file does not exist for the worker (spec: never hand-copy codes, units or categories).
 */
export function loadContract(path: string = defaultContractPath): Contract {
  const raw = JSON.parse(readFileSync(path, "utf8")) as {
    contractVersion?: unknown;
    systems?: { loinc?: unknown; ucum?: unknown };
    metrics?: RawMetric[];
  };
  const version = String(raw.contractVersion ?? "");
  const major = Number(version.split(".")[0]);
  if (major !== SUPPORTED_MAJOR) {
    throw new Error(`contract version ${version} is not supported (this worker supports major ${SUPPORTED_MAJOR})`);
  }
  const loincSystem = String(raw.systems?.loinc ?? "");
  const ucumSystem = String(raw.systems?.ucum ?? "");
  if (!loincSystem || !ucumSystem) {
    throw new Error("contract has no LOINC or UCUM system");
  }
  const quantityMetrics: QuantityMetric[] = [];
  let sleep: SleepMetric | null = null;
  for (const metric of raw.metrics ?? []) {
    if (metric.kind === "sleepStage") {
      const stageByCode = new Map<string, string>();
      for (const [stage, coding] of Object.entries(metric.stages ?? {})) {
        const code = String(coding.code ?? "");
        if (!code) {
          throw new Error(`contract sleep stage ${stage} lacks a code`);
        }
        stageByCode.set(code, stage);
      }
      if (stageByCode.size === 0) {
        throw new Error("contract sleep metric has no stages");
      }
      const unmapped = Array.isArray(metric.unmapped) ? metric.unmapped.map(String) : [];
      sleep = { id: String(metric.id ?? ""), stageByCode, unmapped };
      continue;
    }
    if (metric.kind !== "quantity") {
      continue; // an unknown kind is not rolled up
    }
    const id = String(metric.id ?? "");
    const loincCode = String(metric.loinc?.code ?? "");
    const ucum = String(metric.unit?.ucum ?? "");
    if (!id || !loincCode || !ucum) {
      throw new Error(`contract metric ${id || "(no id)"} lacks a code or unit`);
    }
    quantityMetrics.push({ id, loincCode, ucum });
  }
  if (quantityMetrics.length === 0) {
    throw new Error("contract has no quantity metrics");
  }
  return { version, loincSystem, ucumSystem, quantityMetrics, sleep };
}
