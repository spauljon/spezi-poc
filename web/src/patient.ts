import type { WebConfig } from "./config.ts";
import type { WebContract } from "./contract.ts";
import type { FhirClient } from "./fhir/client.ts";
import type { Patient } from "./fhir/types.ts";

/** Why the patient could not be resolved, for the page to explain. */
export class PatientLoadError extends Error {
  constructor(readonly reason: "patientNotFound" | "patientAmbiguous", message: string) {
    super(message);
    this.name = "PatientLoadError";
  }
}

/** Finds the one patient with the configured business identifier (never a hard-coded id). */
export async function loadPatient(fhir: FhirClient, config: WebConfig, contract: WebContract): Promise<Patient & { id: string }> {
  const identifier = encodeURIComponent(`${contract.patientIdentifierSystem}|${config.patientIdentifier}`);
  const patients = await fhir.resources<Patient>(`Patient?identifier=${identifier}&_count=2`);
  const first = patients[0];
  if (!first) {
    throw new PatientLoadError("patientNotFound", "No patient has the configured identifier.");
  }
  if (patients.length > 1 || !first.id) {
    throw new PatientLoadError("patientAmbiguous", "More than one patient has the configured identifier.");
  }
  return { ...first, id: first.id };
}
