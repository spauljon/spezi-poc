import type { Bundle } from "./types.ts";

export type FhirErrorKind = "unauthorized" | "forbidden" | "network" | "server" | "request";

/** A failure with a stable kind the UI can explain; the message never contains a token or a response body. */
export class FhirError extends Error {
  constructor(readonly kind: FhirErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = "FhirError";
  }
}

export type TokenSource = () => Promise<string>;

/** A small typed read client for HAPI, through the same-origin relay. Reads only: there is no write method. */
export class FhirClient {
  constructor(
    private readonly base: string,
    private readonly token: TokenSource,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = 20_000,
  ) {}

  /** One page of a search. `path` is relative to the FHIR base, for example `Patient?identifier=...`. */
  async search<T>(path: string): Promise<Bundle<T>> {
    const url = `${this.base}/${path}`;
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${await this.token()}`,
          Accept: "application/fhir+json",
          // HAPI otherwise answers an identical search from a 60 s cache: a banner must show what is there now.
          "Cache-Control": "no-cache",
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof FhirError) {
        throw error;
      }
      throw new FhirError("network", "The server could not be reached.");
    }
    if (response.status === 401) {
      throw new FhirError("unauthorized", "The server did not accept the sign-in.", 401);
    }
    if (response.status === 403) {
      throw new FhirError("forbidden", "This account may not read this data.", 403);
    }
    if (response.status >= 500) {
      throw new FhirError("server", `The server reported an error (HTTP ${response.status}).`, response.status);
    }
    if (!response.ok) {
      throw new FhirError("request", `The request was refused (HTTP ${response.status}).`, response.status);
    }
    try {
      return (await response.json()) as Bundle<T>;
    } catch {
      throw new FhirError("server", "The server's response was not understood.", response.status);
    }
  }

  async resources<T>(path: string): Promise<T[]> {
    const bundle = await this.search<T>(path);
    return (bundle.entry ?? []).flatMap((e) => (e.resource ? [e.resource] : []));
  }
}
