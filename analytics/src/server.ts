import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AnalyticApi } from "./api.ts";

export interface ServerOptions {
  readonly keyPath: string;
  readonly certPath: string;
  /** Loopback only, by decision (M11): changing this is a documented, deliberate act. */
  readonly host: string;
  readonly port: number;
}

/** TLS only; GET only (no request body is ever read); a failure is a generic 500 with no detail. */
export function createApiServer(api: AnalyticApi, o: ServerOptions): Server {
  const server = createServer(
    { key: readFileSync(o.keyPath), cert: readFileSync(o.certPath), minVersion: "TLSv1.2", maxHeaderSize: 8192 },
    (req, res) => {
      const finish = (status: number, headers: Record<string, string>, body: unknown): void => {
        const payload = body === null ? "" : JSON.stringify(body);
        res.writeHead(status, { ...headers, "Content-Length": String(Buffer.byteLength(payload)) });
        res.end(payload);
      };
      const headers: Record<string, string | undefined> = {};
      for (const name of ["authorization", "origin"]) {
        const value = req.headers[name];
        headers[name] = Array.isArray(value) ? value[0] : value;
      }
      api
        .handle({ method: req.method ?? "GET", url: req.url ?? "/", headers })
        .then((r) => finish(r.status, r.headers, r.body))
        .catch(() => finish(500, { "Content-Type": "application/json", "Cache-Control": "no-store" },
          { error: "internal", detail: "The request could not be completed." }));
    },
  );
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 1000;
  return server;
}

export function listen(server: Server, o: ServerOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(o.port, o.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
