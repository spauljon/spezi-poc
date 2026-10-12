import { ClientCredentials } from "./auth.ts";
import { loadContract } from "./contract.ts";
import { HapiClient } from "./fhir.ts";
import { OracleStore } from "./oracle-store.ts";
import { RollupWorker } from "./worker.ts";

/**
 * `node --import tsx src/main.ts [once|loop|status]` (normally via `analytics/run.sh`, which supplies the
 * credentials from the git-ignored env files and trusts the POC CA).
 */
function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

async function main(): Promise<number> {
  const command = process.argv[2] ?? "once";
  if (!["once", "loop", "status"].includes(command)) {
    console.error("usage: main.ts [once|loop|status]");
    return 2;
  }
  const contract = loadContract();
  const store = await OracleStore.connect({
    user: env("ANALYTICS_DB_USER"),
    password: env("ANALYTICS_DB_PASSWORD"),
    connectString: env("POC_ANALYTICS_CONNECT", "127.0.0.1:1522/ANALYTICSPDB"),
  });
  const name = env("POC_WORKER_NAME", "rollup-worker");
  try {
    if (command === "status") {
      const rows = await store.rollups();
      const sleep = await store.nights();
      const pending = await store.pendingWindows(10_000);
      const watermark = await store.getWatermark(name);
      console.log(JSON.stringify({
        worker: name,
        contract: contract.version,
        watermark: watermark === null ? null : new Date(watermark).toISOString(),
        rollupRows: rows.length,
        sleepSessions: sleep.length,
        pendingWindows: pending.length,
      }));
      return 0;
    }
    const issuer = env("POC_ISSUER_URL", "https://macpro16.local:8444/realms/poc");
    const credentials = new ClientCredentials(issuer, env("POC_WORKER_CLIENT_ID", "analytics-worker"), env("POC_WORKER_CLIENT_SECRET"));
    const worker = new RollupWorker({
      name,
      contract,
      store,
      fhir: new HapiClient(env("POC_FHIR_BASE_URL", "https://macpro16.local:8443/fhir"), () => credentials.token()),
    });
    const intervalMs = Number(env("POC_WORKER_INTERVAL_SECONDS", "30")) * 1000;
    do {
      const report = await worker.runOnce();
      console.log(JSON.stringify({ at: new Date().toISOString(), ...report }));
      if (command === "loop") {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    } while (command === "loop");
    return 0;
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
    console.error(`analytics worker failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
