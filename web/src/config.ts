export interface WebConfig {
  /** The OpenID issuer, for example `https://macpro16.local:8444/realms/poc`. */
  readonly issuer: string;
  readonly clientId: string;
  /** Same-origin paths the dev server relays; the browser never calls HAPI or the API directly. */
  readonly fhirBase: string;
  readonly analyticsBase: string;
  /** Value of the capture patient's business identifier (system comes from the contract). */
  readonly patientIdentifier: string;
  /** Data older than this (by when the server received it) is shown as stale. */
  readonly staleAfterMinutes: number;
  readonly redirectUri: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Nothing environment-specific lives in source: the issuer follows the host the app was opened on, and the rest has
 * explicit defaults that `VITE_*` variables override.
 */
export function loadConfig(env: Env, location: Pick<Location, "origin" | "hostname">): WebConfig {
  const issuer = env["VITE_POC_ISSUER_URL"] ?? `https://${location.hostname}:8444/realms/poc`;
  if (new URL(issuer).protocol !== "https:") {
    throw new Error("VITE_POC_ISSUER_URL must be an https URL");
  }
  const stale = Number(env["VITE_POC_STALE_AFTER_MINUTES"] ?? "30");
  if (!Number.isFinite(stale) || stale <= 0) {
    throw new Error("VITE_POC_STALE_AFTER_MINUTES must be a positive number");
  }
  return {
    issuer,
    clientId: env["VITE_POC_CLIENT_ID"] ?? "clinician-web",
    fhirBase: "/fhir",
    analyticsBase: "/analytics",
    patientIdentifier: env["VITE_POC_PATIENT_IDENTIFIER"] ?? "poc-0001",
    staleAfterMinutes: stale,
    redirectUri: `${location.origin}/callback`,
  };
}
