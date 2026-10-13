# web/ — Clinician web app

Follow the root [CLAUDE.md](../CLAUDE.md) (data rules, milestone workflow, FHIR rules). The data rules apply here without exception: synthetic data only in fixtures, tests and logs.

- Stack: Node.js as pinned in the root `.nvmrc` (`scripts/check-node.sh` enforces it; Vite 8 and Vitest do not support odd releases such as 21), React 19 and TypeScript, Vite (dev server and build), Vitest + Testing Library (jsdom), `oidc-client-ts`. Packages are pinned exactly and were approved for M12; adding any other needs approval (the charting library is a decision for M14).
- The web dev server is TLS only, on all interfaces, port 3000 (decided, recorded in the root CLAUDE.md). It relays `/fhir` (GET/HEAD only) and `/analytics`; the browser never calls HAPI or the analytic API directly, so no CORS is configured on HAPI. Keep `server.fs.allow` to `web/` and `contract/`.
- Tokens stay in memory: never put a token in localStorage, sessionStorage, a URL or a log. The UI role check is display only.
- Do not use `Observation/$lastn` (unusable on this HAPI); use plain sorted searches. `meta.source` is `<uri>#<request id>` on stored resources: compare the URI part (`sourceUri`). Do not sort by `_source` (unordered) or filter with `:not` on it (ignored).
- The flowsheet leaves filtering, ordering, windowing and the total to HAPI; any new sort column must be verified against the server's real ordering first.
- Staleness and missing data are always stated in words (and never by colour alone); times are shown with an explicit zone.
- Tests: `make test-web` (no stack); `make test-web-live` (read-only, needs the stack and the CA).
- Milestones: M12-M16
- Contract: codes, units and categories come from `contract/metrics.json` (added in M6), never hand-copied.
- Commit prefix: `web:`

