import type { WebContract } from "../contract.ts";
import type { FhirClient } from "../fhir/client.ts";
import type { Observation } from "../fhir/types.ts";
import type { SleepSession } from "./api.ts";
import {
  nightStats, resolveTimeline, toStageInterval, type NightStats, type Segment, type SkipReason, type StageInterval,
} from "./model.ts";

export const PAGE_SIZE = 200;
export const MAX_PAGES = 10;

/**
 * The stage intervals of ONE session: those that overlap its window [start, end). HAPI matches a period that overlaps
 * the range, so a neighbouring session more than two hours away is not returned; one that touches the window is
 * filtered below. Ordered by `date` then `_id` so offset paging is stable.
 */
export function nightSearch(patientId: string, contract: WebContract, session: Pick<SleepSession, "start" | "end">, offset: number): string {
  const codes = contract.sleepStages.map((s) => `${contract.loincSystem}|${s.loincCode}`).join(",");
  const parts = [
    `patient=${encodeURIComponent(`Patient/${patientId}`)}`,
    `code=${encodeURIComponent(codes)}`,
    `date=ge${encodeURIComponent(session.start)}`,
    `date=lt${encodeURIComponent(session.end)}`,
    "_sort=date,_id",
    `_count=${PAGE_SIZE}`,
    `_offset=${offset}`,
    "_total=accurate",
  ];
  return `Observation?${parts.join("&")}`;
}

export interface NightModel {
  readonly intervals: readonly StageInterval[];
  readonly segments: readonly Segment[];
  readonly stats: NightStats | null;
  readonly skipped: Readonly<Record<SkipReason, number>>;
}

export async function loadNight(
  client: FhirClient,
  patientId: string,
  contract: WebContract,
  session: Pick<SleepSession, "start" | "end">,
  cancelled: () => boolean = () => false,
): Promise<NightModel> {
  const startMs = Date.parse(session.start);
  const endMs = Date.parse(session.end);
  const intervals: StageInterval[] = [];
  const skipped: Record<SkipReason, number> = { retracted: 0, unknownStage: 0, noPeriod: 0, empty: 0 };
  let total: number | null = null;
  let fetched = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (cancelled()) break;
    const bundle = await client.search<Observation>(nightSearch(patientId, contract, session, page * PAGE_SIZE));
    if (page === 0 && typeof bundle.total === "number") total = bundle.total;
    const rows = (bundle.entry ?? []).flatMap((e) => (e.resource ? [e.resource] : []));
    for (const o of rows) {
      const r = toStageInterval(o, contract);
      if (typeof r === "string") skipped[r]++;
      // an interval that merely touches the window belongs to a neighbouring session
      else if (r.endMs > startMs && r.startMs < endMs) intervals.push(r);
    }
    fetched += rows.length;
    if (rows.length < PAGE_SIZE || (total !== null && fetched >= total)) break;
  }
  const seen = new Set<string>();
  const unique = intervals.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  const segments = resolveTimeline(unique);
  return { intervals: unique, segments, stats: nightStats(segments), skipped };
}

/** The fields of the analytic summary that the timeline must reproduce, with the largest difference in minutes. */
export function disagreement(stats: NightStats, session: SleepSession): { field: string; web: number; api: number } | null {
  const pairs: Array<[string, number, number]> = [
    ["asleepMin", stats.asleepMin, session.asleepMin], ["coreMin", stats.coreMin, session.coreMin], ["deepMin", stats.deepMin, session.deepMin],
    ["remMin", stats.remMin, session.remMin], ["unspecifiedMin", stats.unspecifiedMin, session.unspecifiedMin],
    ["awakeMin", stats.awakeMin, session.awakeMin], ["unscoredMin", stats.unscoredMin, session.unscoredMin],
    ["overlapMin", stats.overlapMin, session.overlapMin], ["latencyMin", stats.latencyMin, session.latencyMin],
    ["wakeAfterEndMin", stats.wakeAfterEndMin, session.wakeAfterEndMin], ["awakenings", stats.awakenings, session.awakenings],
  ];
  for (const [field, web, api] of pairs) {
    if (Math.abs(web - api) > 0.05) return { field, web, api };
  }
  return null;
}
