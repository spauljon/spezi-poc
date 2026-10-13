# web/ — Clinician web app

Follow the root [CLAUDE.md](../CLAUDE.md) (data rules, milestone workflow, FHIR rules). The data rules apply here without exception: synthetic data only in fixtures, tests and logs.

- Stack: Node.js as pinned in the root `.nvmrc` (`scripts/check-node.sh` enforces it; Vite 8 and Vitest do not support odd releases such as 21), React 19 and TypeScript, Vite (dev server and build), Vitest + Testing Library (jsdom), `oidc-client-ts`. Packages are pinned exactly and were approved for M12, plus `uplot` (the charting library, approved for M14, 1.6.32); adding any other needs approval.
- The web dev server is TLS only, on all interfaces, port 3000 (decided, recorded in the root CLAUDE.md). It relays `/fhir` (GET/HEAD only) and `/analytics`; the browser never calls HAPI or the analytic API directly, so no CORS is configured on HAPI. Keep `server.fs.allow` to `web/` and `contract/`.
- Deployed form (M13a): `web/Dockerfile` + `web/nginx/nginx.conf` (production build behind the pinned nginx, upstream TLS verified, GET/HEAD only, CSP). `make web-dev` is the dev server on the same port and refuses to start while the service runs.
- Tokens stay in memory: never put a token in localStorage, sessionStorage, a URL or a log. The UI role check is display only.
- Do not use `Observation/$lastn` (unusable on this HAPI); use plain sorted searches. `meta.source` is `<uri>#<request id>` on stored resources: compare the URI part (`sourceUri`). Do not sort by `_source` (unordered) or filter with `:not` on it (ignored).
- The flowsheet leaves filtering, ordering, windowing and the total to HAPI; any new sort column must be verified against the server's real ordering first.
- Staleness and missing data are always stated in words (and never by colour alone); times are shown with an explicit zone.
- Tests: `make test-web` (no stack); `make test-web-live` (needs the stack and the CA; it reads, except for two idempotent synthetic status fixtures).
- Charts (M14+): uPlot, loaded on demand through `src/trends/library.ts` (tests inject `test/uplot-fake.ts`). One categorical slot per metric by its contract position; run `dataviz`'s validator for any new colour. A missing day is `null`, never a filled value; every chart has a text summary, an arrow-key readout and a table twin. Time ticks are ours, at UTC midnights.
- Milestones: M12-M16
- Contract: codes, units and categories come from `contract/metrics.json` (added in M6), never hand-copied.
- Commit prefix: `web:`

