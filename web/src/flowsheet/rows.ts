import type { SourceKind } from "../banner/model.ts";
import { sourceKind } from "../banner/model.ts";
import type { WebContract } from "../contract.ts";
import type { Observation } from "../fhir/types.ts";
import { flowMetrics } from "./query.ts";

export interface FlowRow {
  readonly id: string;
  /** The sample's own time (its instant, or the start of its period). */
  readonly measured: string | null;
  /** End of a period-valued sample (sleep stages), else `null`. */
  readonly measuredEnd: string | null;
  readonly metric: string;
  readonly known: boolean;
  readonly value: number | null;
  /** The contract's unit for a known code; otherwise whatever the resource says (never invented). */
  readonly unit: string;
  /** The resource's own unit differs from the contract's: shown, not corrected. */
  readonly unitMismatch: string | null;
  readonly source: SourceKind;
  readonly status: string;
  readonly received: string | null;
}

/** One table row per Observation, with provenance and anything unexpected kept visible. */
export function toRow(o: Observation, contract: WebContract): FlowRow {
  const coding = o.code?.coding?.find((c) => c.system === contract.loincSystem);
  const metric = flowMetrics(contract).find((m) => m.code === coding?.code);
  const q = o.valueQuantity;
  const ownUnit = q?.code ?? q?.unit ?? "";
  return {
    id: o.id ?? `${o.effectiveDateTime ?? o.effectivePeriod?.start ?? "?"}-${coding?.code ?? "?"}`,
    measured: o.effectiveDateTime ?? o.effectivePeriod?.start ?? null,
    measuredEnd: o.effectivePeriod?.end ?? null,
    metric: metric?.display ?? (coding?.code ? `Unknown code ${coding.code}` : "Unknown code"),
    known: metric !== undefined,
    value: typeof q?.value === "number" ? q.value : null,
    unit: metric?.unit ?? ownUnit,
    unitMismatch: metric && ownUnit !== "" && ownUnit !== metric.unit ? ownUnit : null,
    source: sourceKind(o.meta, contract),
    status: o.status ?? "unknown",
    received: o.meta?.lastUpdated ?? null,
  };
}
