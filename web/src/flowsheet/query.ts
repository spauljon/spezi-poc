import type { WebContract } from "../contract.ts";

/** One selectable metric in the flowsheet: a quantity metric or a sleep stage, straight from the contract. */
export interface FlowMetric {
  readonly key: string;
  readonly display: string;
  readonly code: string;
  readonly unit: string;
  readonly kind: "quantity" | "sleep";
}

export function flowMetrics(contract: WebContract): FlowMetric[] {
  return [
    ...contract.quantityMetrics.map((m): FlowMetric => ({ key: m.id, display: m.display, code: m.loincCode, unit: m.unit, kind: "quantity" })),
    ...contract.sleepStages.map((s): FlowMetric => ({ key: s.id, display: s.display, code: s.loincCode, unit: contract.sleepUnit, kind: "sleep" })),
  ];
}

/** Columns the server can order by (each verified against this HAPI; `_source` is not: it came back unordered). */
export type SortColumn = "measured" | "metric" | "value" | "status" | "received";
const SORT_PARAM: Record<SortColumn, string> = {
  measured: "date",
  metric: "code",
  value: "value-quantity",
  status: "status",
  received: "_lastUpdated",
};
export const SORT_COLUMNS = Object.keys(SORT_PARAM) as SortColumn[];

export type SourceFilter = "any" | "synthetic" | "healthKit";

/** FHIR `Observation.status` (R4 value set); the flowsheet shows every status, flagged, never hidden. */
export const OBSERVATION_STATUSES = [
  "registered", "preliminary", "final", "amended", "corrected", "cancelled", "entered-in-error", "unknown",
] as const;

export interface FlowQuery {
  /** Selected metric keys; empty means every contract metric (the flowsheet never shows non-contract codes). */
  readonly metrics: readonly string[];
  /** UTC days `YYYY-MM-DD`, both inclusive; either may be absent. */
  readonly from: string | null;
  readonly to: string | null;
  readonly source: SourceFilter;
  /** `any` or a FHIR status code. */
  readonly status: string;
  readonly sort: { readonly column: SortColumn; readonly direction: "asc" | "desc" };
  /** Zero-based. */
  readonly page: number;
  readonly pageSize: number;
}

export const PAGE_SIZES = [25, 50, 100] as const;

export const defaultQuery: FlowQuery = {
  metrics: [],
  from: null,
  to: null,
  source: "any",
  status: "any",
  sort: { column: "measured", direction: "desc" },
  page: 0,
  pageSize: 25,
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: string): boolean => DAY.test(v) && Number.isFinite(Date.parse(`${v}T00:00:00Z`));
const nextDay = (day: string): string => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** A problem with the filter values themselves (shown next to the form; no request is made). */
export function validateQuery(q: FlowQuery): string | null {
  if (q.from !== null && !isDay(q.from)) return "The start date is not a valid date.";
  if (q.to !== null && !isDay(q.to)) return "The end date is not a valid date.";
  if (q.from !== null && q.to !== null && q.from > q.to) return "The start date is after the end date.";
  return null;
}

/**
 * The FHIR search for one page. Everything is done by the server (filter, order, window, total) so the table is
 * correct over any number of rows. `_id` is the final sort key so that equal keys cannot reorder between pages
 * (paging by offset would otherwise duplicate or skip rows).
 */
export function buildSearch(q: FlowQuery, patientId: string, contract: WebContract): string {
  const all = flowMetrics(contract);
  const chosen = q.metrics.length === 0 ? all : all.filter((m) => q.metrics.includes(m.key));
  const subject = encodeURIComponent(`Patient/${patientId}`);
  const tokens = chosen.map((m) => `${contract.loincSystem}|${m.code}`).join(",");
  const parts = [
    `patient=${subject}`,
    `code=${encodeURIComponent(tokens)}`,
  ];
  if (q.status !== "any") {
    parts.push(`status=${encodeURIComponent(q.status)}`);
  }
  if (q.source !== "any") {
    parts.push(`_source=${encodeURIComponent(contract.metaSource[q.source])}`);
  }
  if (q.from !== null) {
    parts.push(`date=ge${q.from}T00:00:00Z`);
  }
  if (q.to !== null) {
    parts.push(`date=lt${nextDay(q.to)}T00:00:00Z`);
  }
  const sign = q.sort.direction === "desc" ? "-" : "";
  parts.push(`_sort=${sign}${SORT_PARAM[q.sort.column]},_id`);
  parts.push(`_count=${q.pageSize}`, `_offset=${q.page * q.pageSize}`, "_total=accurate");
  return `Observation?${parts.join("&")}`;
}
