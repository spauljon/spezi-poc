// Container healthchecks for the analytics image (plain JS: it runs every 30 s, so it must start fast).
//
//   node healthcheck.mjs worker   healthy if the loop wrote its heartbeat within the last 3 minutes. The loop beats
//                                 after every attempt, successful or failed, so this proves the scheduler is alive;
//                                 whether scans SUCCEED is visible in the logs and in `status`.
//   node healthcheck.mjs api      healthy if https://127.0.0.1:8445/v1/metrics answers 401: the TLS handshake with the
//                                 POC CA works, the process is serving, and the request was refused for want of a
//                                 token (a 200 here would be a bug, and anything else is unhealthy).
import { statSync } from "node:fs";
import { request } from "node:https";

const mode = process.argv[2];

function fail(message) {
  console.error(`unhealthy: ${message}`);
  process.exit(1);
}

if (mode === "worker") {
  const file = process.env.POC_HEARTBEAT_FILE;
  if (!file) fail("POC_HEARTBEAT_FILE is not set");
  let age;
  try {
    age = Date.now() - statSync(file).mtimeMs;
  } catch {
    fail("no heartbeat yet");
  }
  if (age > 3 * 60_000) fail(`last heartbeat ${Math.round(age / 1000)} s ago`);
  process.exit(0);
}

if (mode === "api") {
  const req = request(
    {
      host: "127.0.0.1",
      port: Number(process.env.POC_API_PORT ?? 8445),
      path: "/v1/metrics",
      servername: "macpro16.local", // the certificate is for the POC host name, verified as that name
      method: "GET",
      timeout: 5000,
    },
    (res) => {
      res.resume();
      if (res.statusCode === 401) process.exit(0);
      fail(`HTTP ${res.statusCode}, expected 401`);
    },
  );
  req.on("timeout", () => req.destroy(new Error("timeout")));
  req.on("error", (e) => fail(e.code ?? e.message));
  req.end();
} else {
  fail("usage: healthcheck.mjs worker|api");
}
