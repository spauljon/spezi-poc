.PHONY: test test-contract test-db test-idp test-hapi test-ios test-ios-ui test-analytics test-web \
        guard guard-all guard-selftest hooks \
        stack-env tls stack-up stack-down stack-ps stack-reset stack-verify \
        isolation-before isolation-after

test: test-contract test-db test-idp test-hapi test-ios test-analytics test-web

# Placeholders until each project has tests (replaced milestone by milestone).
test-contract:  ## offline contract checks: structure, LOINC check digits, bundled copy, golden fixtures
	@python3 contract/check.py
# Static checks only: no containers are started.
test-db:
	@bash -n db/init.sh db/make-env.sh db/verify.sh scripts/make-tls.sh idp/make-env.sh scripts/isolation.sh scripts/compose.sh scripts/bootstrap.sh scripts/reset.sh && echo "db: shell syntax ok"
	@if [ -f db/.env.local ] && [ -f hapi/.env.local ]; then \
	   ./scripts/compose.sh --profile initialize config -q && echo "db: compose config ok"; \
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
test-analytics:
	@echo "analytics: no tests yet (added in M9)"
test-web:
	@echo "web: no tests yet (added in M12)"

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
tls: stack-env  ## create the local CA and the HAPI, proxy and Keycloak certificates (idempotent)
	@./scripts/make-tls.sh
stack-up:       ## first run: init profile once, then marker; later runs: plain up -d
	@./scripts/bootstrap.sh
stack-down:     ## stop the POC stack including the IdP (keeps the data volumes)
	@./scripts/compose.sh --profile initialize down
stack-ps:
	@./scripts/compose.sh ps
stack-reset:    ## remove containers and (after confirmation) the Oracle volume and marker
	@./scripts/reset.sh
stack-verify:   ## M1 checks against the running stack
	@./db/verify.sh
isolation-before: ## snapshot non-POC docker state
	@./scripts/isolation.sh before
isolation-after:  ## confirm nothing outside the POC project changed
	@./scripts/isolation.sh after
