import type { Contract } from "./contract.ts";
import { isDay, nextDay } from "./day.ts";
import { bearerToken, type JwtVerifier } from "./jwt.ts";
import type { Reader, StoredRollup, StoredSleepSession } from "./store.ts";

export const MAX_RANGE_DAYS = 366;
export const PATIENT_ID = /^[A-Za-z0-9\-.]{1,64}$/;

export interface ApiOptions {
  readonly contract: Contract;
  readonly reader: Reader;
  readonly verifier: Pick<JwtVerifier, "verify">;
  /** The worker whose watermark is reported. */
  readonly workerName: string;
  /** The single origin allowed to call from a browser (the clinician web app); `null` for none. */
  readonly corsOrigin: string | null;
  readonly now?: () => number;
}

export interface ApiRequest {
  readonly method: string;
  /** Path and query, as received. */
  readonly url: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Reply = (status: number, body: unknown, extra?: Record<string, string>) => ApiResponse;

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/** Every UTC day from `from` to `to` inclusive. Callers have validated both and the span. */
function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = nextDay(d)) {
    out.push(d);
  }
  return out;
}

function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/**
 * The analytic API as a pure function of a request: no sockets, so it is tested without a server. Routes:
 *
 *   GET /v1/metrics                                              metrics the bands exist for
 *   GET /v1/patients/{id}/bands?metric=&from=&to=                daily min/median/max (UTC days, inclusive)
 *   GET /v1/patients/{id}/sleep?from=&to=                        sleep sessions by night (UTC date of waking)
 *
 * Every response says how complete it is (days with no data, windows still being recomputed, how far the worker has
 * read, when the rows last changed), because absence of data is never a normal reading.
 */
export class AnalyticApi {
  constructor(private readonly o: ApiOptions) {}

  async handle(req: ApiRequest): Promise<ApiResponse> {
    const origin = req.headers["origin"];
    const corsAllowed = this.o.corsOrigin !== null && origin === this.o.corsOrigin;
    const base: Record<string, string> = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Type": "application/json; charset=utf-8",
    };
    if (corsAllowed && origin !== undefined) {
      base["Access-Control-Allow-Origin"] = origin;
      base["Vary"] = "Origin";
    }
    const reply: Reply = (status, body, extra = {}) => ({ status, headers: { ...base, ...extra }, body });

    let url: URL;
    try {
      url = new URL(req.url, "https://api.invalid");
    } catch {
      return reply(400, { error: "bad_request", detail: "The URL could not be parsed." });
    }

    // Browser preflight: no credentials by design, answered before authentication, and only for the one origin.
    if (req.method === "OPTIONS") {
      return corsAllowed
        ? reply(204, null, {
          "Access-Control-Allow-Methods": "GET",
          "Access-Control-Allow-Headers": "Authorization",
          "Access-Control-Max-Age": "600",
        })
        : reply(403, { error: "forbidden", detail: "Origin not allowed." });
    }

    // Authenticate first: nothing about routes or parameters is revealed to an anonymous caller.
    const denied = await this.authenticate(req, reply);
    if (denied) {
      return denied;
    }
    if (req.method !== "GET") {
      return reply(405, { error: "method_not_allowed", detail: "Only GET is supported." }, { Allow: "GET, OPTIONS" });
    }
    return this.route(url, reply);
  }

  /** `null` when the caller is allowed; otherwise the refusal to send. */
  private async authenticate(req: ApiRequest, reply: Reply): Promise<ApiResponse | null> {
    const token = bearerToken(req.headers["authorization"]);
    if (!token) {
      return reply(401, { error: "unauthorized", detail: "A bearer token is required." },
        { "WWW-Authenticate": 'Bearer realm="poc-analytics"' });
    }
    const verdict = await this.o.verifier.verify(token);
    if (verdict.ok) {
      return null;
    }
    switch (verdict.status) {
      case 401:
        return reply(401, { error: "unauthorized", detail: "The token was not accepted." },
          { "WWW-Authenticate": 'Bearer realm="poc-analytics", error="invalid_token"' });
      case 403:
        return reply(403, { error: "forbidden", detail: "The token does not grant access to this API." });
      default:
        return reply(503, { error: "unavailable", detail: "Token verification is temporarily unavailable." });
    }
  }

  private route(url: URL, reply: Reply): Promise<ApiResponse> | ApiResponse {
    let decoded: string[];
    try {
      decoded = url.pathname.split("/").filter((s) => s.length > 0).map((s) => decodeURIComponent(s));
    } catch {
      return reply(400, { error: "bad_request", detail: "The path is not valid." });
    }
    const [version, resource, patientId, view] = decoded;
    if (version !== "v1") {
      return reply(404, { error: "not_found", detail: "No such resource." });
    }
    if (decoded.length === 2 && resource === "metrics") {
      return reply(200, this.metrics());
    }
    if (decoded.length === 4 && resource === "patients" && patientId !== undefined) {
      if (!PATIENT_ID.test(patientId)) {
        return reply(400, { error: "bad_request", detail: "The patient id is not valid." });
      }
      if (view === "bands") {
        return this.bands(patientId, url.searchParams, reply);
      }
      if (view === "sleep") {
        return this.sleep(patientId, url.searchParams, reply);
      }
    }
    return reply(404, { error: "not_found", detail: "No such resource." });
  }

  private metrics() {
    return {
      contractVersion: this.o.contract.version,
      metrics: this.o.contract.quantityMetrics.map((m) => ({ id: m.id, display: m.display, unit: m.ucum })),
    };
  }

  private range(
    params: URLSearchParams,
    reply: (status: number, body: unknown) => ApiResponse,
  ): { from: string; to: string } | ApiResponse {
    const from = params.get("from");
    const to = params.get("to");
    if (!from || !to || !isDay(from) || !isDay(to)) {
      return reply(400, { error: "bad_request", detail: "`from` and `to` are required as YYYY-MM-DD." });
    }
    if (from > to) {
      return reply(400, { error: "bad_request", detail: "`from` must not be after `to`." });
    }
    if (spanDays(from, to) > MAX_RANGE_DAYS) {
      return reply(400, { error: "bad_request", detail: `The range may span at most ${MAX_RANGE_DAYS} days.` });
    }
    return { from, to };
  }

  private async bands(
    patientId: string,
    params: URLSearchParams,
    reply: (status: number, body: unknown) => ApiResponse,
  ): Promise<ApiResponse> {
    const metricId = params.get("metric");
    const metric = this.o.contract.quantityMetrics.find((m) => m.id === metricId);
    if (!metric) {
      return reply(400, { error: "bad_request", detail: "`metric` must be one of the ids from /v1/metrics." });
    }
    const range = this.range(params, reply);
    if ("status" in range) {
      return range;
    }
    const rows = await this.o.reader.bands(patientId, metric.id, range.from, range.to);
    const pending = await this.o.reader.pendingCount(patientId, [metric.id], range.from, range.to);
    const bands = rows.map((r: StoredRollup) => ({
      day: r.day, n: r.n, min: r.min, median: r.median, max: r.max, revision: r.revision,
    }));
    return reply(200, {
      patientId,
      metric: { id: metric.id, display: metric.display, unit: metric.ucum },
      from: range.from,
      to: range.to,
      dayDefinition: "UTC calendar day of the sample's instant",
      bands,
      completeness: await this.completeness(range, rows.map((r) => r.day), pending, rows.map((r) => r.updatedAtMs)),
    });
  }

  private async sleep(
    patientId: string,
    params: URLSearchParams,
    reply: (status: number, body: unknown) => ApiResponse,
  ): Promise<ApiResponse> {
    const sleep = this.o.contract.sleep;
    if (!sleep) {
      return reply(404, { error: "not_found", detail: "Sleep is not part of the contract." });
    }
    const range = this.range(params, reply);
    if ("status" in range) {
      return range;
    }
    const rows = await this.o.reader.sleepNights(patientId, range.from, range.to);
    const pending = await this.o.reader.pendingCount(patientId, [sleep.id], range.from, range.to);
    const sessions = rows.map((s: StoredSleepSession) => ({
      night: s.night,
      isMain: s.isMain,
      start: new Date(s.sessionStartMs).toISOString(),
      end: new Date(s.sessionEndMs).toISOString(),
      onset: new Date(s.onsetMs).toISOString(),
      finalWaking: new Date(s.lastAsleepEndMs).toISOString(),
      asleepMin: s.asleepMin,
      coreMin: s.coreMin,
      deepMin: s.deepMin,
      remMin: s.remMin,
      unspecifiedMin: s.unspecifiedMin,
      awakeMin: s.awakeMin,
      latencyMin: s.latencyMin,
      wakeAfterEndMin: s.wakeAfterEndMin,
      unscoredMin: s.unscoredMin,
      overlapMin: s.overlapMin,
      awakenings: s.awakenings,
      intervalCount: s.intervalCount,
      revision: s.revision,
    }));
    return reply(200, {
      patientId,
      from: range.from,
      to: range.to,
      nightDefinition: "UTC date of the final waking from sleep; sessions are separated by gaps over 2 hours",
      sessions,
      completeness: await this.completeness(range, rows.map((r) => r.night), pending, rows.map((r) => r.updatedAtMs)),
    });
  }

  private async completeness(
    range: { from: string; to: string },
    presentDays: readonly string[],
    pending: number,
    updatedAtMs: readonly number[],
  ) {
    const present = new Set(presentDays);
    const all = daysBetween(range.from, range.to);
    const missing = all.filter((d) => !present.has(d));
    const watermark = await this.o.reader.getWatermark(this.o.workerName);
    return {
      requestedDays: all.length,
      daysWithData: all.length - missing.length,
      missingDays: missing,
      pendingWindows: pending,
      lastComputedAt: iso(updatedAtMs.length > 0 ? Math.max(...updatedAtMs) : null),
      workerWatermark: iso(watermark),
      generatedAt: new Date((this.o.now ?? Date.now)()).toISOString(),
    };
  }
}
