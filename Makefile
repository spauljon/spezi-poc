.PHONY: test test-contract test-hapi test-ios test-analytics test-web guard guard-all guard-selftest hooks

test: test-contract test-hapi test-ios test-analytics test-web

# Placeholders until each project has tests (replaced milestone by milestone).
test-contract:
	@echo "contract: no tests yet (added in M5)"
test-hapi:
	@echo "hapi: no tests yet (added in M1)"
test-ios:
	@echo "ios: no tests yet (added in M4/M5)"
test-analytics:
	@echo "analytics: no tests yet (added in M8)"
test-web:
	@echo "web: no tests yet (added in M11)"

guard:          ## scan staged files
	@./scripts/guard.sh
guard-all:      ## scan every non-ignored file in the working tree
	@./scripts/guard.sh --all
guard-selftest: ## verify the guard blocks and allows what it should
	@./scripts/guard-selftest.sh
hooks:          ## enable the pre-commit guard for this clone
	git config core.hooksPath .githooks
