# Makefile for mcp-confluent integration test lifecycle.
#
# Used by .semaphore/semaphore.yml's per-PR tool-group blocks and
# .semaphore/integration.yml's per-service-config blocks to pull secrets
# from Vault, run a single matrix cell, and publish results to Semaphore.
# Also works locally: `make setup-test-env` once, then
# `make test-integration SERVICE_CONFIG=@requires-kafka-config TAGS=@kafka`.

VAULT_SECRET_BASE ?= stag/kv/semaphore/mcpconfluent/testing
ENV_FILE ?= .env.integration
# SERVICE_CONFIG filters tests by service-config tag (e.g. @requires-kafka-config) -
# drives integration.yml's matrix axis. TAGS layers an AND-filter on top
# (typically a tool-group tag like @kafka, or @smoke). Both default to empty;
# unset, `test-integration` runs the full integration suite. TRANSPORT filters
# which MCP transport each file's describe.each exercises.
SERVICE_CONFIG ?=
TAGS ?=
TRANSPORT ?=

# Vault paths -> fields. Each entry is `<path-suffix>:<comma-separated-fields>`,
# split in setup-test-env. Only secrets live in Vault; non-secret config
# (endpoints, IDs, names) is supplied via Semaphore env_vars in CI and
# `.env.integration` locally.
VAULT_PATH_FIELDS := \
	kafka:KAFKA_API_KEY,KAFKA_API_SECRET \
	schema-registry:SCHEMA_REGISTRY_API_KEY,SCHEMA_REGISTRY_API_SECRET \
	confluent-cloud-api:CONFLUENT_CLOUD_API_KEY,CONFLUENT_CLOUD_API_SECRET \
	confluent-cloud-user:CONFLUENT_CLOUD_USERNAME,CONFLUENT_CLOUD_PASSWORD \
	flink:FLINK_API_KEY,FLINK_API_SECRET \
	tableflow:TABLEFLOW_API_KEY,TABLEFLOW_API_SECRET \
	telemetry:TELEMETRY_API_KEY,TELEMETRY_API_SECRET

.PHONY: setup-test-env remove-test-env test-integration store-unit-test-results store-integration-test-results

# Pull integration secrets into $(ENV_FILE). Fails fast if `vault` isn't on
# PATH or the user isn't authed. Empty Vault reads (missing field, no
# permission) are SKIPPED rather than written as empty strings — env-schema's
# `.optional()` accepts undefined but rejects empty string, so writing empty
# would crash the spawned server with a Zod error instead of letting tests
# skip via their predicate gate. The `.env.integration.example` file
# documents the full expected shape. chmod 600 keeps secrets out of
# world-readable mode on shared machines.
setup-test-env:
	@command -v vault >/dev/null 2>&1 || { \
		echo "ERROR: 'vault' CLI not found on PATH. Install it or populate $(ENV_FILE) manually (see CONTRIBUTING.md)."; \
		exit 1; \
	}
	@vault kv get -format=json $(VAULT_SECRET_BASE)/kafka >/dev/null 2>&1 || { \
		echo "ERROR: cannot read Vault path $(VAULT_SECRET_BASE)/kafka. Run 'vault login' or check Vault access."; \
		exit 1; \
	}
	@echo "writing $(ENV_FILE) from $(VAULT_SECRET_BASE)/{kafka,schema-registry,confluent-cloud-*,flink,tableflow,telemetry}"
	@rm -f $(ENV_FILE)
	@touch $(ENV_FILE) && chmod 600 $(ENV_FILE)
	@for entry in $(VAULT_PATH_FIELDS); do \
		path_suffix=$${entry%%:*}; \
		fields=$${entry#*:}; \
		for field in $$(echo $$fields | tr ',' ' '); do \
			value=$$(vault kv get -field=$$field $(VAULT_SECRET_BASE)/$$path_suffix 2>/dev/null || true); \
			if [ -n "$$value" ]; then \
				echo "$$field=$$value" >> $(ENV_FILE); \
			fi; \
		done; \
	done

remove-test-env:
	@rm -f $(ENV_FILE)

# Run the integration tests. SERVICE_CONFIG and TAGS compose into a single
# vitest tag expression: an empty value drops that clause. When TAGS names a
# non-smoke tool-group tag whose value matches a `handlers/<dir>/`, we also
# pass that directory as a positional scope filter so vitest only collects
# files under it; without the scope, --tags-filter is a runtime-skip filter
# that still loads (and prints as skipped) every file in the project's
# include glob. @smoke and empty TAGS fall through to a filter on just the
# service config, since neither is directory-aligned.
#
# When INTEGRATION_TEST_CONNECTION_TYPE is set (manual full-promotion
# CONNECTION_TYPE parameter forwards into this env var), we append a
# `@oauth` / `!@oauth` clause to the tag filter:
#  - `direct` lane excludes oauth describes (`!@oauth`), so single-mode
#    direct-only tests don't re-run alongside dual-mode oauth describes.
#  - `oauth` lane only collects oauth describes (`@oauth`), so the cell
#    skips every direct-only test and only exercises the PKCE-flow paths.
# Unset (local dev) skips the clause entirely; vitest collects everything.
#
# Any run that isn't direct-only also appends `--no-file-parallelism`: that's
# the `oauth` lane AND the combined `all`/unset default (which still collects
# the oauth describes). Every oauth describe binds the single hard-coded OAuth
# callback port, and the lock now *balks* on a live concurrent holder (see
# tests/harness/oauth-port-lock.ts), so oauth describes must never run across
# parallel forks. Serializing the files removes the contention — each oauth file
# acquires the free lock immediately. Only the explicit `direct` lane stays
# parallel; its describes never touch the port. This is what keeps the
# combined-mode scheduled run (`.semaphore/integration.yml`, CONNECTION_TYPE=all)
# green without splitting its per-service-config cells.
#
# The `!= "SERVICE_CONFIG"` / `!= "TOOL_GROUP"` / `!= "TRANSPORT"` guards
# catch a Semaphore misconfiguration where a matrix env-var name leaks
# through uninterpolated (e.g. `make test-integration TAGS=TOOL_GROUP` if
# `$TOOL_GROUP` failed to expand in integration.yml's job command); without
# them, vitest would silently match 0 tests.
#
# `set --` builds argv one word at a time so values containing `&&` (e.g.
# `--tags-filter=@requires-kafka-config && @kafka`) stay quoted as a single
# argument; an unquoted variable would let the shell interpret `&&` as a
# control operator and split the npm command. Vitest is invoked directly
# via `npx vitest run` rather than `npm run test:integration --` for the
# same reason: npm concatenates trailing `--` args into the script string
# verbatim, so `&&` inside a filter value would split that script too.
test-integration:
	@echo "running integration tests: service_config=$(SERVICE_CONFIG) tags=$(TAGS) transport=$(TRANSPORT) connection_type=$$INTEGRATION_TEST_CONNECTION_TYPE"
	@set --; \
	SERVICE_CONFIG_VAL=""; [ -n "$(SERVICE_CONFIG)" ] && [ "$(SERVICE_CONFIG)" != "SERVICE_CONFIG" ] && SERVICE_CONFIG_VAL="$(SERVICE_CONFIG)"; \
	TAGS_VAL=""; [ -n "$(TAGS)" ] && [ "$(TAGS)" != "TOOL_GROUP" ] && TAGS_VAL="$(TAGS)"; \
	TRANSPORT_VAL=""; [ -n "$(TRANSPORT)" ] && [ "$(TRANSPORT)" != "TRANSPORT" ] && TRANSPORT_VAL="$(TRANSPORT)"; \
	CONNECTION_FILTER=""; \
	case "$$INTEGRATION_TEST_CONNECTION_TYPE" in \
		direct) CONNECTION_FILTER="!@oauth";; \
		oauth) CONNECTION_FILTER="@oauth";; \
	esac; \
	FILTER_PARTS=""; \
	if [ -n "$$SERVICE_CONFIG_VAL" ]; then FILTER_PARTS="$$SERVICE_CONFIG_VAL"; fi; \
	if [ -n "$$TAGS_VAL" ]; then \
		if [ -n "$$FILTER_PARTS" ]; then \
			FILTER_PARTS="$$FILTER_PARTS && $$TAGS_VAL"; \
		else \
			FILTER_PARTS="$$TAGS_VAL"; \
		fi; \
	fi; \
	if [ -n "$$CONNECTION_FILTER" ]; then \
		if [ -n "$$FILTER_PARTS" ]; then \
			FILTER_PARTS="$$FILTER_PARTS && $$CONNECTION_FILTER"; \
		else \
			FILTER_PARTS="$$CONNECTION_FILTER"; \
		fi; \
	fi; \
	if [ -n "$$FILTER_PARTS" ]; then \
		set -- "$$@" "--tags-filter=$$FILTER_PARTS"; \
	fi; \
	if [ -n "$$TAGS_VAL" ] && [ "$$TAGS_VAL" != "@smoke" ]; then \
		TAG_SUFFIX=$$(echo "$$TAGS_VAL" | sed 's/^@//'); \
		if [ -d "src/confluent/tools/handlers/$$TAG_SUFFIX" ]; then \
			set -- "$$@" "src/confluent/tools/handlers/$$TAG_SUFFIX"; \
		fi; \
	fi; \
	if [ "$$INTEGRATION_TEST_CONNECTION_TYPE" != "direct" ]; then \
		set -- "$$@" "--no-file-parallelism"; \
	fi; \
	if [ ! -f dist/index.js ]; then pnpm run build; fi && \
	INTEGRATION_TEST_TRANSPORT="$$TRANSPORT_VAL" pnpm exec vitest run \
		--project integration \
		--outputFile.junit=TEST-integration.xml \
		"$$@"
# ^ `pnpm run build` is skipped when `dist/index.js` already exists. CI's
# integration prologue builds before invoking `make test-integration`, so
# this avoids the double build per matrix cell. Local devs running cold
# (no `dist/`) still get an automatic build; for staleness control,
# `rm -rf dist && make test-integration ...` or running `npm run dev` in a
# watch terminal alongside.

# publish JUnit results to semaphore: each test lane writes a distinct file via package.json's
# --outputFile.junit overrides, so per-test-type publishing stays separated in the Semaphore UI

store-unit-test-results:
	@if [ -f TEST-unit.xml ]; then \
		test-results publish TEST-unit.xml --name "Unit" --force; \
	else \
		echo "no TEST-unit.xml to publish"; \
	fi

store-integration-test-results:
	@if [ -f TEST-integration.xml ]; then \
		test-results publish TEST-integration.xml --name "Integration ($(SERVICE_CONFIG) / $(TAGS) / $${INTEGRATION_TEST_CONNECTION_TYPE:-all})" --force; \
	else \
		echo "no TEST-integration.xml to publish"; \
	fi
