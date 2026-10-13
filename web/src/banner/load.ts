import type { WebConfig } from "../config.ts";
import type { WebContract } from "../contract.ts";
import type { FhirClient } from "../fhir/client.ts";
import type { Observation, Patient } from "../fhir/types.ts";
import { buildBanner, type BannerModel } from "./model.ts";

/** `code=<system>|<code>`, escaped. */
function codeParam(system: string, code: string): string {
  const token = `${system}|${code}`;
  return `code=${encodeURIComponent(token)}`;
}

/**
 * Reads the facts the banner needs for an already-resolved patient with plain searches:
 *
 *  - the newest Observation of each quantity metric by its own time (`_sort=-date&_count=1`), and
 *  - the newest Observation of ANY kind by when the server received it (`_sort=-_lastUpdated&_count=1`), which is
 *    "last data received" (sleep stages included).
 *
 * `Observation/$lastn` is deliberately not used: this HAPI has no Elasticsearch behind it and was observed to answer
 * it with unrelated, unordered Observations that ignore both `code` and `max` (see the plan, M12).
 */
export async function loadBanner(
  fhir: FhirClient,
  config: WebConfig,
  contract: WebContract,
  now: Date,
  patient: Patient & { id: string },
): Promise<BannerModel> {
  const reference = encodeURIComponent(`Patient/${patient.id}`);
  const subject = `patient=${reference}`;
  const perMetric = contract.quantityMetrics.map((m) =>
    fhir.resources<Observation>(
      `Observation?${subject}&${codeParam(contract.loincSystem, m.loincCode)}&_sort=-date&_count=1`));
  const newestReceived = fhir.resources<Observation>(
    `Observation?${subject}&_sort=-_lastUpdated&_count=1&_elements=meta`);
  const results = await Promise.all([...perMetric, newestReceived]);
  return buildBanner(patient, results.flat(), contract, now, config.staleAfterMinutes);
}
