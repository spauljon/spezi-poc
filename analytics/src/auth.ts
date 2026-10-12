/**
 * Client-credentials tokens for the worker's service account (`analytics-worker`, role `worker-reader`). The token
 * is cached and renewed `skewMs` before it expires; it is never logged and never part of an error message.
 */
export class ClientCredentials {
  private cached: { value: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly issuer: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly now: () => number = Date.now,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly skewMs = 60_000,
  ) {}

  async token(): Promise<string> {
    if (this.cached && this.now() < this.cached.expiresAt - this.skewMs) {
      return this.cached.value;
    }
    this.inflight ??= this.fetchToken().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const response = await this.fetchImpl(`${this.issuer}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      throw new Error(`the token endpoint returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || typeof body.expires_in !== "number") {
      throw new Error("the token response was not understood");
    }
    this.cached = { value: body.access_token, expiresAt: this.now() + body.expires_in * 1000 };
    return body.access_token;
  }
}
