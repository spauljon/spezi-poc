.PHONY: test test-contract test-db test-idp test-hapi test-ios test-ios-ui test-ios-integration test-analytics-live analytics-migrate analytics-rescan analytics-run analytics-api web-dev web-seed-dense-day web-seed-sleep-nights web-seed-nutrition-days test-web-live test-analytics test-web \
        guard guard-all guard-selftest hooks \
        stack-env tls stack-up stack-down stack-ps stack-reset stack-verify \
        isolation-before isolation-after

test: test-contract test-db test-idp test-hapi test-ios test-analytics test-web

# Placeholders until each project has tests (replaced milestone by milestone).
test-contract:  ## offline contract checks: structure, LOINC check digits, bundled copy, golden fixtures, retired app names
	@python3 contract/check.py
	@./scripts/check-names.sh
# Static checks only: no containers are started.
test-db:
	@bash -n db/init.sh db/init-status.sh db/startup/10-poc-init.sh db/make-env.sh db/verify.sh scripts/make-tls.sh idp/make-env.sh scripts/isolation.sh scripts/compose.sh scripts/bootstrap.sh scripts/reset.sh && echo "db: shell syntax ok"
	@if [ -f db/.env.local ] && [ -f hapi/.env.local ]; then \
	   ./scripts/compose.sh config -q && echo "db: compose config ok"; \
	 else echo "db: compose config skipped (run make stack-env first)"; fi
test-idp:
	@bash -n idp/make-env.sh idp/verify-allowlist.sh idp/test-config.sh idp/db-migrate.sh && echo "idp: shell syntax ok"
	@python3 -c "import ast; ast.parse(open('idp/oidc.py').read())" && echo "idp: oidc.py parses"
	@python3 -c "import json; json.load(open('idp/realm/poc-realm.json'))" && echo "idp: realm template is valid JSON"
	@./idp/test-config.sh
test-hapi:
	@python3 -c "import ast; ast.parse(open('hapi/auth.py').read())" && echo "hapi: auth.py parses"
	@out=$$(docker build --progress=plain --no-cache-filter build-ext --target build-ext -t spezi-poc-hapi-ext-test hapi 2>&1) \
	  || { echo "$$out" | tail -40; echo "hapi: extension build or unit tests FAILED"; exit 1; }; \
	  echo "hapi: extension unit tests: $$(echo "$$out" | grep 'Tests run:' | tail -1 | sed 's/.*Tests run:/Tests run:/')"
test-ios:  ## iOS unit tests on a simulator (macOS + Xcode); `make test-ios-ui` adds the UI tests
	@./scripts/ios-test.sh
test-ios-ui:
	@./scripts/ios-test.sh --ui
test-ios-integration:  ## upload to the live POC stack (synthetic data); needs the stack up and the CA trusted in the simulator
	@./scripts/ios-test.sh --integration
test-analytics:  ## worker unit and contract tests (Node); `make test-analytics-live` needs the stack
	@./scripts/check-node.sh && cd analytics && { [ -d node_modules ] || npm ci --silent; } && npm test --silent
test-analytics-live:  ## rollups against the live stack: HAPI + Keycloak + Oracle (synthetic data)
	@./analytics/live-test.sh
analytics-migrate:  ## (re)apply the analytic store schema: reruns the database init in the oracle container (idempotent)
	@docker exec spezi-poc-oracle bash /opt/poc/db/init.sh
analytics-rescan: ## make the deployed worker re-read every Observation on its next cycle (run after a contract change adds a metric)
	@./analytics/run.sh rescan
analytics-run:  ## one worker cycle on the host (the deployed worker already scans every 30 s; this is for ad hoc runs)
	@./analytics/run.sh once
analytics-api:  ## DEV: the analytic API on the host (port 8445); the deployed stack already serves it, so stop that first
	@if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^spezi-poc-analytics-api$$'; then echo "analytics-api: the deployed service owns 127.0.0.1:8445 (spezi-poc-analytics-api). It is already running; to run from source instead: docker stop spezi-poc-analytics-api"; exit 1; fi
	@./analytics/run.sh api
test-web:  ## clinician web app: typecheck + unit and component tests (Node; no stack needed)
	@./scripts/check-node.sh && cd web && { [ -d node_modules ] || npm ci --silent; } && npm test --silent
test-web-live:  ## read-only banner data path against the live stack (HAPI + Keycloak)
	@./web/live-test.sh
web-seed-dense-day:  ## seed one dense synthetic day (heart rate every 4 s) for the intraday view; idempotent
	@./web/seed-dense-day.sh
web-seed-sleep-nights:  ## seed three known synthetic sleep nights (overlap, unscored gap, a nap, a DST night) for the sleep view; idempotent
	@./web/seed-sleep-nights.sh
web-seed-nutrition-days:  ## seed 24 known synthetic dietary intake days (gaps, a zero day, an evening entry, a retraction, a flagged entry) for the nutrition view; idempotent
	@./web/seed-nutrition-days.sh
web-dev:  ## DEV: Vite's dev server on :3000 (hot reload); the deployed stack already serves the built app, so stop that first
	@if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^spezi-poc-web$$'; then echo "web-dev: the deployed web app owns port 3000 (spezi-poc-web), already running at https://macpro16.local:3000; to use the dev server instead: docker stop spezi-poc-web"; exit 1; fi
	@./scripts/check-node.sh && cd web && { [ -d node_modules ] || npm ci --silent; } && npm run dev

guard:          ## scan staged files
	@./scripts/guard.sh
guard-all:      ## scan every non-ignored file in the working tree
	@./scripts/guard.sh --all
guard-selftest: ## verify the guard blocks and allows what it should
	@./scripts/guard-selftest.sh
hooks:          ## enable the pre-commit guard for this clone
	git config core.hooksPath .githooks

# POC stack (compose project: spezi-poc). See db/README.md for the bring-up order.
stack-env:      ## generate gitignored local credentials (never overwrites)
	@./db/make-env.sh
	@./idp/make-env.sh
	@./analytics/make-env.sh
tls: stack-env  ## create the local CA and the HAPI, proxy and Keycloak certificates (idempotent)
	@./scripts/make-tls.sh
stack-up:       ## bring the whole stack up; the database initializes itself (idempotent, same path every time)
	@./scripts/bootstrap.sh
stack-down:     ## stop the POC stack including the IdP (keeps the data volumes)
	@./scripts/compose.sh down
stack-ps:
	@./scripts/compose.sh ps
stack-reset:    ## remove containers and (after confirmation) the Oracle volume
	@./scripts/reset.sh
stack-verify:   ## M1 checks against the running stack
	@./db/verify.sh
isolation-before: ## snapshot non-POC docker state
	@./scripts/isolation.sh before
isolation-after:  ## confirm nothing outside the POC project changed
	@./scripts/isolation.sh after
