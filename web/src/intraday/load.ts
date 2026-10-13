import type { QuantityMetric, WebContract } from "../contract.ts";
import type { FhirClient } from "../fhir/client.ts";
import type { Observation } from "../fhir/types.ts";
import { buildDay, nextDay, noSkips, toSample, type DayModel, type Sample, type Skipped } from "./model.ts";

export const PAGE_SIZE = 1000;
/** Safety stop: 200 pages of 1,000 is far beyond any one metric-day (a 1 s cadence is 86,400). */
export const MAX_PAGES = 200;

/**
 * One page of a metric's samples for a UTC day. Ordered by `date` then `_id`, so equal instants cannot reorder
 * between pages (paging by offset would otherwise repeat or skip rows), and only the elements the view needs.
 */
export function daySearch(patientId: string, metric: QuantityMetric, contract: WebContract, day: string, offset: number, count = PAGE_SIZE): string {
  const parts = [
    `patient=${encodeURIComponent(`Patient/${patientId}`)}`,
    `code=${encodeURIComponent(`${contract.loincSystem}|${metric.loincCode}`)}`,
    `date=ge${day}T00:00:00Z`,
    `date=lt${nextDay(day)}T00:00:00Z`,
    "_sort=date,_id",
    `_count=${count}`,
    `_offset=${offset}`,
    "_total=accurate",
    "_elements=effectiveDateTime,effectivePeriod,valueQuantity,status,meta",
  ];
  return `Observation?${parts.join("&")}`;
}

export interface LoadOptions {
  readonly pageSize?: number;
  readonly now?: Date;
  readonly onProgress?: (loaded: number, total: number | null) => void;
  /** Checked between pages: a superseded load stops asking for more. */
  readonly cancelled?: () => boolean;
}

/** Pages through the whole day and builds its model. A failure on any page fails the load (never a partial day). */
export async function loadDay(
  client: FhirClient,
  patientId: string,
  metric: QuantityMetric,
  contract: WebContract,
  day: string,
  options: LoadOptions = {},
): Promise<DayModel> {
  const size = options.pageSize ?? PAGE_SIZE;
  const samples: Sample[] = [];
  const skipped: { -readonly [K in keyof Skipped]: number } = { ...noSkips() };
  let total: number | null = null;
  let fetched = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (options.cancelled?.()) break;
    const bundle = await client.search<Observation>(daySearch(patientId, metric, contract, day, page * size, size));
    if (page === 0 && typeof bundle.total === "number") total = bundle.total;
    const rows = (bundle.entry ?? []).flatMap((e) => (e.resource ? [e.resource] : []));
    for (const o of rows) {
      const s = toSample(o, metric, contract);
      if (typeof s === "string") skipped[s]++;
      else samples.push(s);
    }
    fetched += rows.length;
    options.onProgress?.(fetched, total);
    if (rows.length < size || (total !== null && fetched >= total)) break;
  }
  return buildDay(day, samples, skipped, options.now);
}
