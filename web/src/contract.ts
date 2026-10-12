import raw from "../../contract/metrics.json";

/**
 * The metric registry as the web app sees it. It is read from `contract/metrics.json` (the single source of truth,
 * shared with the iOS app and the analytics worker); no code, unit or system is written anywhere else in `src/`.
 */
export interface QuantityMetric {
  readonly id: string;
  readonly loincCode: string;
  readonly display: string;
  readonly unit: string;
}

export interface WebContract {
  readonly version: string;
  readonly loincSystem: string;
  readonly patientIdentifierSystem: string;
  readonly metaSource: { readonly synthetic: string; readonly healthKit: string };
  readonly quantityMetrics: readonly QuantityMetric[];
  /** LOINC code -> stage id for sleep stages (used for "last data received", not displayed here). */
  readonly sleepStageCodes: readonly string[];
}

interface RawMetric {
  id: string;
  kind: string;
  loinc?: { code: string; display: string };
  unit: { ucum: string; display: string };
  stages?: Record<string, { code: string }>;
}

export const SUPPORTED_MAJOR = 1;

export function parseContract(file: unknown): WebContract {
  const c = file as {
    contractVersion: string;
    systems: {
      loinc: string;
      identifier: { patient: string };
      metaSource: { synthetic: string; healthKit: string };
    };
    metrics: RawMetric[];
  };
  if (Number(c.contractVersion.split(".")[0]) !== SUPPORTED_MAJOR) {
    throw new Error(`contract version ${c.contractVersion} is not supported (supported major: ${SUPPORTED_MAJOR})`);
  }
  const quantityMetrics = c.metrics
    .filter((m) => m.kind === "quantity" && m.loinc)
    .map((m) => ({ id: m.id, loincCode: m.loinc!.code, display: m.loinc!.display, unit: m.unit.ucum }));
  const sleepStageCodes = c.metrics
    .filter((m) => m.kind === "sleepStage")
    .flatMap((m) => Object.values(m.stages ?? {}).map((s) => s.code));
  return {
    version: c.contractVersion,
    loincSystem: c.systems.loinc,
    patientIdentifierSystem: c.systems.identifier.patient,
    metaSource: c.systems.metaSource,
    quantityMetrics,
    sleepStageCodes,
  };
}

export const contract: WebContract = parseContract(raw);
