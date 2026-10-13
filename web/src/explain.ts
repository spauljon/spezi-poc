import { FhirError } from "./fhir/client.ts";
import { PatientLoadError } from "./patient.ts";

export interface Explained {
  readonly title: string;
  readonly detail: string;
  /** Whether trying again can help (a network or server problem, not a permission or data problem). */
  readonly retry: boolean;
}

/** One place that turns a failure into words a clinician can act on; never includes tokens or response bodies. */
export function explainError(error: unknown): Explained {
  if (error instanceof PatientLoadError) {
    return {
      title: error.reason === "patientNotFound" ? "Patient not found" : "More than one patient matches",
      detail: error.message,
      retry: false,
    };
  }
  if (error instanceof FhirError) {
    switch (error.kind) {
      case "unauthorized":
        return { title: "Your sign-in was not accepted", detail: "Please sign in again.", retry: false };
      case "forbidden":
        return { title: "Not permitted", detail: "This account may not read patient data.", retry: false };
      case "network":
        return { title: "The server could not be reached", detail: "Check the connection and try again.", retry: true };
      default:
        return { title: "The server reported a problem", detail: error.message, retry: true };
    }
  }
  return { title: "Something went wrong", detail: "The data could not be loaded.", retry: true };
}
