import { parseSleep, SleepShapeError, type SleepResponse } from "../sleep/api.ts";
import { parseBands, TrendShapeError, type BandsResponse, type MetricInfo } from "./model.ts";

export type AnalyticsErrorKind = "unauthorized" | "forbidden" | "unavailable" | "network" | "server" | "request" | "shape";

/** A failure with a stable kind the UI can explain; the message never contains a token or a response body. */
export class AnalyticsError extends Error {
  constructor(readonly kind: AnalyticsErrorKind, message: string, readonly status?: number) {
    super(message);
    this.name = "AnalyticsError";
  }
}

export type TokenSource = () => Promise<string>;

/** Read-only client for the analytic API, through the same-origin relay (`/analytics`, GET and HEAD only). */
export class AnalyticsClient {
  constructor(
    private readonly base: string,
    private readonly token: TokenSource,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly timeoutMs = 20_000,
  ) {}

  async metrics(): Promise<{ contractVersion: string; metrics: MetricInfo[] }> {
    const body = await this.get("v1/metrics");
    const m = body as { contractVersion?: unknown; metrics?: unknown };
    if (typeof m.contractVersion !== "string" || !Array.isArray(m.metrics)) {
      throw new AnalyticsError("shape", "The metric list was not understood.");
    }
    const metrics = m.metrics.map((x: unknown) => {
      const r = x as Record<string, unknown>;
      if (typeof r["id"] !== "string" || typeof r["display"] !== "string" || typeof r["unit"] !== "string") {
        throw new AnalyticsError("shape", "The metric list was not understood.");
      }
      return { id: r["id"], display: r["display"], unit: r["unit"] };
    });
    return { contractVersion: m.contractVersion, metrics };
  }

  async bands(patientId: string, metric: string, from: string, to: string): Promise<BandsResponse> {
    const q = new URLSearchParams({ metric, from, to });
    const body = await this.get(`v1/patients/${encodeURIComponent(patientId)}/bands?${q.toString()}`);
    try {
      return parseBands(body);
    } catch (error) {
      if (error instanceof TrendShapeError) {
        throw new AnalyticsError("shape", `The analytic service's answer was not understood (${error.message})`);
      }
      throw error;
    }
  }

  async sleep(patientId: string, from: string, to: string): Promise<SleepResponse> {
    const q = new URLSearchParams({ from, to });
    const body = await this.get(`v1/patients/${encodeURIComponent(patientId)}/sleep?${q.toString()}`);
    try {
      return parseSleep(body);
    } catch (error) {
      if (error instanceof SleepShapeError) {
        throw new AnalyticsError("shape", `The analytic service's answer was not understood (${error.message})`);
      }
      throw error;
    }
  }

  private async get(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}/${path}`, {
        headers: { Authorization: `Bearer ${await this.token()}`, Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new AnalyticsError("network", "The analytic service could not be reached.");
    }
    if (response.status === 401) throw new AnalyticsError("unauthorized", "The service did not accept the sign-in.", 401);
    if (response.status === 403) throw new AnalyticsError("forbidden", "This account may not read this data.", 403);
    if (response.status === 503) throw new AnalyticsError("unavailable", "The analytic store is not available.", 503);
    if (response.status >= 500) throw new AnalyticsError("server", `The service reported an error (HTTP ${response.status}).`, response.status);
    if (!response.ok) throw new AnalyticsError("request", `The request was refused (HTTP ${response.status}).`, response.status);
    try {
      return await response.json();
    } catch {
      throw new AnalyticsError("shape", "The analytic service's response was not understood.", response.status);
    }
  }
}
