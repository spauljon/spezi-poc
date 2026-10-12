/** The few Observation fields the worker reads (everything else is requested away with `_elements`). */
export interface ObservationLite {
  id: string;
  subject?: { reference?: string };
  code?: { coding?: { system?: string; code?: string }[] };
  effectiveDateTime?: string;
  effectivePeriod?: { start?: string; end?: string };
  valueQuantity?: { value?: number; unit?: string; system?: string; code?: string };
  meta?: { lastUpdated?: string };
}

export interface FhirSearch {
  /** Every resource of a search, following paging. `path` is relative to the FHIR base. */
  search(path: string): AsyncIterable<ObservationLite>;
}

export type TokenSource = () => Promise<string>;

interface BundleLike {
  entry?: { resource?: ObservationLite }[];
  link?: { relation?: string; url?: string }[];
}

/**
 * Searches HAPI over TLS with a bearer token. Search results are never reused by the server (`Cache-Control:
 * no-cache`): HAPI otherwise answers an identical search from a 60 s cache, which would make a recompute right after
 * a write read stale data.
 */
export class HapiClient implements FhirSearch {
  private readonly base: URL;

  constructor(
    base: string,
    private readonly token: TokenSource,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.base = new URL(base.endsWith("/") ? base : `${base}/`);
    if (this.base.protocol !== "https:") {
      throw new Error("the FHIR base must be https");
    }
  }

  async *search(path: string): AsyncIterable<ObservationLite> {
    let url: URL | null = new URL(path, this.base);
    let pages = 0;
    while (url) {
      if (++pages > 10_000) {
        throw new Error("search paging did not end");
      }
      const bundle: BundleLike = await this.get(url);
      for (const entry of bundle.entry ?? []) {
        if (entry.resource) {
          yield entry.resource;
        }
      }
      const next = bundle.link?.find((l) => l.relation === "next")?.url;
      url = next ? this.sameServer(next) : null;
    }
  }

  /** A `next` link is followed only if it points at the configured server (the token goes with it). */
  private sameServer(link: string): URL {
    const url = new URL(link, this.base);
    // HAPI's links are `<base>?_getpages=...`: the path is the base itself, with or without a trailing slash.
    const basePath = this.base.pathname.replace(/\/$/, "");
    const inBase = url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
    if (url.origin !== this.base.origin || !inBase) {
      throw new Error("refusing to follow a paging link outside the configured FHIR base");
    }
    return url;
  }

  private async get(url: URL): Promise<BundleLike> {
    const response = await this.fetchImpl(url, {
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        Accept: "application/fhir+json",
        "Cache-Control": "no-cache",
      },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`HAPI returned HTTP ${response.status} for ${url.pathname}`);
    }
    return (await response.json()) as BundleLike;
  }
}
