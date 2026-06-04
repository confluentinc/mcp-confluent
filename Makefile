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

# Confluent Platform stack coordinates. Unlike the Vault-backed CCloud creds
# above, these are non-secret: they're fixed by docker-compose.cp-test.yml's
# JAAS config (user_mcp="mcp-secret"), so they live as literals here and just
# get seeded into $(ENV_FILE) for the integration.cp.yaml fixture to
# interpolate. Override CP_SR_READY_URL if your stack exposes SR elsewhere.
CP_COMPOSE_FILE ?= docker-compose.cp-test.yml
CP_KAFKA_USERNAME ?= mcp
CP_KAFKA_PASSWORD ?= mcp-secret
CP_SR_READY_URL ?= http://localhost:8081/subjects

.PHONY: setup-test-env remove-test-env setup-cp-env remove-cp-env test-integration store-unit-test-results store-integration-test-results

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

# Self-contained Confluent Platform setup: brings up the local CP stack
# (docker-compose.cp-test.yml — Kafka on SASL_PLAINTEXT/PLAIN at :9092,
# unauthenticated SR at :8081) and seeds $(ENV_FILE) with the two non-secret
# Kafka creds the integration.cp.yaml fixture interpolates. No Vault, no Cloud
# account — the @cp lane needs neither. The Schema Registry HTTP endpoint is
# the readiness signal: SR depends_on Kafka and won't answer until the broker
# is reachable, so one poll gates on both. Mirrors setup-test-env's
# rm/touch/chmod-600 handling of $(ENV_FILE).
setup-cp-env:
	@command -v docker >/dev/null 2>&1 || { \
		echo "ERROR: 'docker' not found on PATH. Install Docker to run the @cp integration lane."; \
		exit 1; \
	}
	@echo "starting Confluent Platform stack ($(CP_COMPOSE_FILE))"
	@docker compose -f $(CP_COMPOSE_FILE) up -d
	@echo "waiting for Schema Registry at $(CP_SR_READY_URL) (also gates on Kafka readiness)"
	@deadline=$$(( $$(date +%s) + 120 )); \
	until curl -sf -o /dev/null $(CP_SR_READY_URL); do \
		if [ $$(date +%s) -ge $$deadline ]; then \
			echo "ERROR: CP stack not ready within 120s"; \
			docker compose -f $(CP_COMPOSE_FILE) logs --tail=50; \
			exit 1; \
		fi; \
		sleep 2; \
	done
	@echo "CP stack ready; writing CP creds to $(ENV_FILE)"
	@rm -f $(ENV_FILE)
	@touch $(ENV_FILE) && chmod 600 $(ENV_FILE)
	@echo "CP_KAFKA_USERNAME=$(CP_KAFKA_USERNAME)" >> $(ENV_FILE)
	@echo "CP_KAFKA_PASSWORD=$(CP_KAFKA_PASSWORD)" >> $(ENV_FILE)

remove-cp-env:
	@docker compose -f $(CP_COMPOSE_FILE) down -v >/dev/null 2>&1 || true
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
	if [ ! -f dist/index.js ]; then npm run build; fi && \
	INTEGRATION_TEST_TRANSPORT="$$TRANSPORT_VAL" npx vitest run \
		--project integration \
		--outputFile.junit=TEST-integration.xml \
		"$$@"
# ^ `npm run build` is skipped when `dist/index.js` already exists. CI's
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
