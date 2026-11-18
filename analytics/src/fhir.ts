/** The few Observation fields the worker reads (everything else is requested away with `_elements`). */
export interface ObservationLite {
  id: string;
  /** Only `final` counts. A sample deleted in Apple Health is retracted by the capture app as `entered-in-error` (M21). */
  status?: string;
  subject?: { reference?: string };
  code?: { coding?: { system?: string; code?: string }[] };
  /** Dietary intake: the domain entry and, when the source gave one, the meal entry (separate entries, never one coding list). */
  category?: { coding?: { system?: string; code?: string }[] }[];
  effectiveDateTime?: string;
  effectivePeriod?: { start?: string; end?: string };
  valueQuantity?: { value?: number; unit?: string; system?: string; code?: string };
  meta?: { lastUpdated?: string; tag?: { system?: string; code?: string }[] };
}

/**
 * One line of `Observation/_history`: what was done to which version. A DELETE carries no resource and, as HAPI writes it, no
 * time of its own, so the only clock is the one of the answer: `asOfMs` is the server's time when it produced the page.
 */
export interface HistoryEntry {
  readonly method: string;
  /** `Observation/<id>/_history/<version>` as HAPI writes it. */
  readonly url: string;
  readonly asOfMs: number;
}

export interface FhirSearch {
  /** Every resource of a search, following paging. `path` is relative to the FHIR base. */
  search(path: string): AsyncIterable<ObservationLite>;

  /**
   * The entries of a history (`Observation/_history?_since=...`), following paging. HAPI deletes softly: a delete is a
   * new version marked deleted, which a search no longer finds, so the history is the only place a deletion shows.
   */
  history(path: string): AsyncIterable<HistoryEntry>;

  /** One resource (or one version, `Observation/<id>/_history/<v>`), or `null` when the server has no such thing (404 or 410). */
  read(path: string): Promise<ObservationLite | null>;
}

export type TokenSource = () => Promise<string>;

interface BundleLike {
  meta?: { lastUpdated?: string };
  entry?: { resource?: ObservationLite; request?: { method?: string; url?: string }; response?: { lastModified?: string } }[];
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

  async *history(path: string): AsyncIterable<HistoryEntry> {
    let url: URL | null = new URL(path, this.base);
    let pages = 0;
    while (url) {
      if (++pages > 10_000) {
        throw new Error("history paging did not end");
      }
      const bundle: BundleLike = await this.get(url);
      const asOfMs = Date.parse(bundle.meta?.lastUpdated ?? "");
      for (const entry of bundle.entry ?? []) {
        const method = entry.request?.method;
        const target = entry.request?.url;
        if (method && target && Number.isFinite(asOfMs)) {
          yield { method, url: target, asOfMs };
        }
      }
      const next = bundle.link?.find((l) => l.relation === "next")?.url;
      url = next ? this.sameServer(next) : null;
    }
  }

  async read(path: string): Promise<ObservationLite | null> {
    const url = new URL(path, this.base);
    const response = await this.fetchImpl(url, {
      headers: { Authorization: `Bearer ${await this.token()}`, Accept: "application/fhir+json", "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 404 || response.status === 410) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`HAPI returned HTTP ${response.status} for ${url.pathname}`);
    }
    return (await response.json()) as ObservationLite;
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
