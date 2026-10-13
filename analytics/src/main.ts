import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { AnalyticApi } from "./api.ts";
import { ClientCredentials } from "./auth.ts";
import { loadContract, type Contract } from "./contract.ts";
import { HapiClient } from "./fhir.ts";
import { JwtVerifier } from "./jwt.ts";
import { runLoop } from "./loop.ts";
import { OracleStore, type OracleConfig } from "./oracle-store.ts";
import { createApiServer, listen } from "./server.ts";
import { RollupWorker } from "./worker.ts";

/**
 * `node --import tsx src/main.ts [once|loop|status|api]`.
 *
 *   once    one worker cycle, then exit
 *   loop    cycles forever, `POC_WORKER_INTERVAL_SECONDS` apart (30); a failed cycle is logged and retried with
 *           backoff, never fatal. This is what the compose service runs.
 *   status  counts only (watermark, rows, pending windows)
 *   api     the analytic API (loopback-bound by default; see below)
 *
 * Credentials come from the environment (analytics/run.sh on the host, env_file in compose); nothing is printed.
 */
function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const log = (entry: Record<string, unknown>): void => {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }));
};

function oracleConfig(): OracleConfig {
  return {
    user: env("ANALYTICS_DB_USER"),
    password: env("ANALYTICS_DB_PASSWORD"),
    connectString: env("POC_ANALYTICS_CONNECT", "127.0.0.1:1522/ANALYTICSPDB"),
  };
}

function makeWorker(store: OracleStore, contract: Contract, name: string): RollupWorker {
  const issuer = env("POC_ISSUER_URL", "https://macpro16.local:8444/realms/poc");
  const credentials = new ClientCredentials(issuer, env("POC_WORKER_CLIENT_ID", "analytics-worker"), env("POC_WORKER_CLIENT_SECRET"));
  return new RollupWorker({
    name,
    contract,
    store,
    fhir: new HapiClient(env("POC_FHIR_BASE_URL", "https://macpro16.local:8443/fhir"), () => credentials.token()),
  });
}

/** The scheduled scan: owns its database connection and re-opens it after any failure. */
async function runWorkerLoop(contract: Contract, name: string): Promise<number> {
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => controller.abort());
  }
  const config = oracleConfig();
  const heartbeatFile = process.env["POC_HEARTBEAT_FILE"];
  let store: OracleStore | undefined;
  // One credentials object across cycles so the token is reused until shortly before it expires.
  const issuer = env("POC_ISSUER_URL", "https://macpro16.local:8444/realms/poc");
  const credentials = new ClientCredentials(issuer, env("POC_WORKER_CLIENT_ID", "analytics-worker"), env("POC_WORKER_CLIENT_SECRET"));
  const fhir = new HapiClient(env("POC_FHIR_BASE_URL", "https://macpro16.local:8443/fhir"), () => credentials.token());

  log({ worker: "loop", contract: contract.version, intervalSeconds: Number(env("POC_WORKER_INTERVAL_SECONDS", "30")) });
  await runLoop({
    intervalMs: Number(env("POC_WORKER_INTERVAL_SECONDS", "30")) * 1000,
    maxBackoffMs: Number(env("POC_WORKER_MAX_BACKOFF_SECONDS", "300")) * 1000,
    signal: controller.signal,
    cycle: async () => {
      store ??= await OracleStore.connect(config);
      try {
        return await new RollupWorker({ name, contract, store, fhir }).runOnce();
      } catch (error) {
        await store.close().catch(() => undefined);
        store = undefined;
        throw error;
      }
    },
    onResult: (report) => log({ ...report }),
    onError: (error, failures, retryInMs) =>
      // The message only: errors from these libraries carry no credentials (checked by the tests).
      log({ level: "error", message: error instanceof Error ? error.message : String(error), consecutiveFailures: failures, retryInSeconds: Math.round(retryInMs / 1000) }),
    heartbeat: heartbeatFile ? () => writeFileSync(heartbeatFile, String(Date.now())) : () => undefined,
  });
  await store?.close().catch(() => undefined);
  log({ worker: "stopped" });
  return 0;
}

async function runApi(store: OracleStore, contract: Contract, name: string): Promise<number> {
  const issuer = env("POC_ISSUER_URL", "https://macpro16.local:8444/realms/poc");
  const caDir = process.env["POC_TLS_DIR"] ?? `${homedir()}/.poc-ca`;
  const tlsDir = env("POC_API_TLS_DIR", `${caDir}/analytics`);
  const options = {
    keyPath: `${tlsDir}/api.key`,
    certPath: `${tlsDir}/api.crt`,
    // Loopback by default (M11 decision). In the compose service it listens on the compose network's interface and is
    // published to the host on 127.0.0.1 only; widening it is a decision, not a convenience (root CLAUDE.md).
    host: env("POC_API_LISTEN", "127.0.0.1"),
    port: Number(env("POC_API_PORT", "8445")),
  };
  const api = new AnalyticApi({
    contract,
    reader: store,
    verifier: new JwtVerifier({ issuer, audience: "poc-analytics", role: "clinician-reader" }),
    workerName: name,
    corsOrigin: process.env["POC_API_CORS_ORIGIN"] ?? "https://macpro16.local:3000",
  });
  const server = createApiServer(api, options);
  await listen(server, options);
  log({ api: "listening", url: `https://${options.host}:${options.port}`, contract: contract.version });
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? "once";
  if (!["once", "loop", "status", "api"].includes(command)) {
    console.error("usage: main.ts [once|loop|status|api]");
    return 2;
  }
  const contract = loadContract();
  const name = env("POC_WORKER_NAME", "rollup-worker");
  if (command === "loop") {
    return runWorkerLoop(contract, name);
  }

  const store = await OracleStore.connect(oracleConfig());
  try {
    switch (command) {
      case "api":
        return await runApi(store, contract, name);
      case "status": {
        const watermark = await store.getWatermark(name);
        log({
          worker: name,
          contract: contract.version,
          watermark: watermark === null ? null : new Date(watermark).toISOString(),
          rollupRows: (await store.rollups()).length,
          sleepSessions: (await store.nights()).length,
          pendingWindows: (await store.pendingWindows(10_000)).length,
        });
        return 0;
      }
      default:
        log({ ...(await makeWorker(store, contract, name).runOnce()) });
        return 0;
    }
  } finally {
    await store.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // Messages are built by this code and never contain a token, secret or password.
    console.error(`analytics failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
