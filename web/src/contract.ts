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

/** One dietary intake metric (contract `kind: "intake"`): a daily total, never a band. */
export interface IntakeMetric {
  readonly id: string;
  /** A short name for the nutrient, from its contract id (`dietaryEnergy` is "Energy"), so the contract stays the one source. */
  readonly label: string;
  /** The contract's own name for the code (a LOINC display or the project's code display). */
  readonly display: string;
  readonly unit: string;
}

/** A meal the contract defines, in the contract's order. */
export interface MealType {
  readonly code: string;
  readonly display: string;
}

export interface WebContract {
  readonly version: string;
  readonly loincSystem: string;
  readonly patientIdentifierSystem: string;
  readonly metaSource: { readonly synthetic: string; readonly healthKit: string };
  /** The project's data-quality flag system (an Observation.meta.tag coding system) and its codes. */
  readonly dataQualityFlag: { readonly system: string; readonly artifactSuspected: string; readonly duplicateResolved: string; readonly lateArrival: string; readonly userEntered: string };
  readonly quantityMetrics: readonly QuantityMetric[];
  /** Dietary intake metrics (contract 1.5.0), in the contract's order. */
  readonly intakeMetrics: readonly IntakeMetric[];
  /** The contract's meal types, in its order. */
  readonly mealTypes: readonly MealType[];
  /** Sleep stage codes (used for "last data received"). */
  readonly sleepStageCodes: readonly string[];
  /** Sleep stages: one duration Observation per stage interval. */
  readonly sleepStages: readonly SleepStage[];
  readonly sleepUnit: string;
}

export interface SleepStage {
  readonly id: string;
  readonly loincCode: string;
  readonly display: string;
}

interface RawMetric {
  id: string;
  kind: string;
  loinc?: { code: string; display: string };
  customCode?: { code: string; display: string };
  unit: { ucum: string; display: string };
  stages?: Record<string, { code: string; display?: string }>;
}

export const SUPPORTED_MAJOR = 1;

export function parseContract(file: unknown): WebContract {
  const c = file as {
    contractVersion: string;
    systems: {
      loinc: string;
      identifier: { patient: string };
      metaSource: { synthetic: string; healthKit: string };
      dataQualityFlag?: string;
    };
    dataQualityFlags?: { artifactSuspected?: string; duplicateResolved?: string; lateArrival?: string; userEntered?: string };
    mealTypes?: Record<string, { code?: string; display?: string }>;
    metrics: RawMetric[];
  };
  if (Number(c.contractVersion.split(".")[0]) !== SUPPORTED_MAJOR) {
    throw new Error(`contract version ${c.contractVersion} is not supported (supported major: ${SUPPORTED_MAJOR})`);
  }
  const flags = c.dataQualityFlags;
  if (!c.systems.dataQualityFlag || !flags?.artifactSuspected || !flags.duplicateResolved || !flags.lateArrival || !flags.userEntered) {
    throw new Error("the contract has no data-quality flag system and codes (contract 1.3.0 or later is required)");
  }
  const quantityMetrics = c.metrics
    .filter((m) => m.kind === "quantity" && m.loinc)
    .map((m) => ({ id: m.id, loincCode: m.loinc!.code, display: m.loinc!.display, unit: m.unit.ucum }));
  const intakeMetrics: IntakeMetric[] = c.metrics
    .filter((m) => m.kind === "intake")
    .map((m) => {
      const named = m.customCode ?? m.loinc;
      if (!named) throw new Error(`contract intake metric ${m.id} has no code`);
      // `dietaryEnergy` -> "Energy": the id without its prefix, capitalised
      const bare = m.id.replace(/^dietary/, "");
      return { id: m.id, label: bare.charAt(0).toUpperCase() + bare.slice(1), display: named.display, unit: m.unit.ucum };
    });
  const mealTypes: MealType[] = Object.values(c.mealTypes ?? {})
    .filter((m): m is { code: string; display?: string } => typeof m.code === "string")
    .map((m) => ({ code: m.code, display: m.display ?? m.code }));
  const sleep = c.metrics.find((m) => m.kind === "sleepStage");
  const sleepStages: SleepStage[] = Object.entries(sleep?.stages ?? {}).map(([id, s]) => ({
    id, loincCode: s.code, display: s.display ?? id,
  }));
  const sleepStageCodes = sleepStages.map((s) => s.loincCode);
  return {
    version: c.contractVersion,
    loincSystem: c.systems.loinc,
    patientIdentifierSystem: c.systems.identifier.patient,
    metaSource: c.systems.metaSource,
    dataQualityFlag: {
      system: c.systems.dataQualityFlag,
      artifactSuspected: flags.artifactSuspected,
      duplicateResolved: flags.duplicateResolved,
      lateArrival: flags.lateArrival,
      userEntered: flags.userEntered,
    },
    quantityMetrics,
    intakeMetrics,
    mealTypes,
    sleepStageCodes,
    sleepStages,
    sleepUnit: sleep?.unit.ucum ?? "",
  };
}

export const contract: WebContract = parseContract(raw);
