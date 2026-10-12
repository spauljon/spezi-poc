import type { WebConfig } from "../config.ts";
import type { WebContract } from "../contract.ts";
import type { FhirClient } from "../fhir/client.ts";
import type { Observation, Patient } from "../fhir/types.ts";
import { buildBanner, type BannerModel } from "./model.ts";

/** Why a banner could not be built, for the page to explain. */
export class BannerLoadError extends Error {
  constructor(readonly reason: "patientNotFound" | "patientAmbiguous", message: string) {
    super(message);
    this.name = "BannerLoadError";
  }
}

/** `code=<system>|<code>`, escaped. */
function codeParam(system: string, code: string): string {
  return `code=${encodeURIComponent(`${system}|${code}`)}`;
}

/**
 * Finds the patient by business identifier, then reads the facts the banner needs with plain searches:
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
): Promise<BannerModel> {
  const identifier = encodeURIComponent(`${contract.patientIdentifierSystem}|${config.patientIdentifier}`);
  const patients = await fhir.resources<Patient>(`Patient?identifier=${identifier}&_count=2`);
  if (patients.length === 0) {
    throw new BannerLoadError("patientNotFound", "No patient has the configured identifier.");
  }
  const patient = patients[0] as Patient;
  if (patients.length > 1 || !patient.id) {
    throw new BannerLoadError("patientAmbiguous", "More than one patient has the configured identifier.");
  }
  const subject = `patient=${encodeURIComponent(`Patient/${patient.id}`)}`;
  const perMetric = contract.quantityMetrics.map((m) =>
    fhir.resources<Observation>(
      `Observation?${subject}&${codeParam(contract.loincSystem, m.loincCode)}&_sort=-date&_count=1`));
  const newestReceived = fhir.resources<Observation>(
    `Observation?${subject}&_sort=-_lastUpdated&_count=1&_elements=meta`);
  const results = await Promise.all([...perMetric, newestReceived]);
  return buildBanner(patient, results.flat(), contract, now, config.staleAfterMinutes);
}
