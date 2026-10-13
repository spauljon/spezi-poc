import react from "@vitejs/plugin-react";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { UserConfig } from "vite";
import { defineConfig } from "vitest/config";

/**
 * The clinician web app's dev server (M12).
 *
 *  - TLS only, on all interfaces, port 3000 (decided: the registered origin https://macpro16.local:3000 must work
 *    without a hosts entry). It serves the static bundle and relays two paths, nothing else:
 *      /fhir       -> HAPI           (read-only: anything but GET/HEAD is refused here)
 *      /analytics  -> analytic API   (loopback-only service, reached server-side; `/analytics` is stripped)
 *    Both targets verify every request's bearer token; this relay adds no credentials of its own.
 *  - Because the browser only ever talks to its own origin, HAPI needs no CORS configuration.
 */
const tlsDir = process.env["POC_TLS_DIR"] ?? `${homedir()}/.poc-ca`;
const host = process.env["POC_TLS_HOST"] ?? "macpro16.local";
const webRoot = fileURLToPath(new URL(".", import.meta.url));
const contractDir = fileURLToPath(new URL("../contract", import.meta.url));

function readOnly(req: IncomingMessage, res: ServerResponse): false | undefined {
  if (req.method === "GET" || req.method === "HEAD") {
    return undefined;
  }
  res.statusCode = 405;
  res.setHeader("Allow", "GET, HEAD");
  res.end();
  return false;
}

export default defineConfig(({ command }) => {
  const serving = command === "serve" && process.env["VITEST"] === undefined;
  const ca = serving ? readFileSync(`${tlsDir}/ca.crt`) : undefined;
  const upstream = (port: number) => ({
    protocol: "https:",
    host: "127.0.0.1",
    port,
    ca,
    // The certificate is for the POC host name, not for 127.0.0.1: verify it as that name.
    servername: host,
  });
  const config = {
    plugins: [react()],
    server: serving
      ? {
        host: true, // all interfaces (decision recorded in the root CLAUDE.md)
        port: 3000,
        strictPort: true,
        allowedHosts: [host],
        https: {
          key: readFileSync(`${tlsDir}/web/web.key`),
          cert: readFileSync(`${tlsDir}/web/web.crt`),
        },
        // On a network-reachable server, never the whole repository (it holds git-ignored credentials): this app's
        // own files and the contract directory it reads, nothing else.
        fs: { allow: [webRoot, contractDir] },
        proxy: {
          "/fhir": {
            target: upstream(8443) as never,
            secure: true,
            headers: { Host: `${host}:8443` },
            bypass: readOnly,
          },
          "/analytics": {
            target: upstream(8445) as never,
            secure: true,
            headers: { Host: `${host}:8445` },
            rewrite: (path: string) => path.replace(/^\/analytics/, ""),
            bypass: readOnly,
          },
        },
      }
      : {},
    test: {
      environment: "jsdom",
      include: ["test/**/*.test.{ts,tsx}"],
      setupFiles: ["./test/setup.ts"],
      restoreMocks: true,
    },
  };
  // The proxy `target` object form (an https agent's options) is accepted by http-proxy but not by Vite's types.
  return config as unknown as UserConfig;
});
