# Makefile for mcp-confluent integration test lifecycle.
#
# Used by .semaphore/integration.yml to pull secrets from Vault, run a
# single-tag / single-transport matrix cell, and publish results to
# Semaphore. Also works locally: `make setup-test-env` once, then
# `make test-integration TAG=@kafka`.

VAULT_SECRET_BASE ?= stag/kv/semaphore/mcpconfluent/testing
ENV_FILE ?= .env.integration
# TAG and TRANSPORT default to empty; when unset, `test-integration` runs the full integration
# suite without filtering. Semaphore tasks (service.yml) can set defaults.
TAG ?=
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

.PHONY: setup-test-env remove-test-env test-integration store-integration-test-results

# Pull integration secrets into $(ENV_FILE). Fails fast if `vault` isn't on
# PATH or the user isn't authed; tolerates empty per-field reads so missing
# values surface as test skips rather than setup errors. chmod 600 keeps
# secrets out of world-readable mode on shared machines.
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
			echo "$$field=$$value" >> $(ENV_FILE); \
		done; \
	done

remove-test-env:
	@rm -f $(ENV_FILE)

# Run the integration tests. TAG filters tests by tool-group tag; TRANSPORT
# filters which MCP transport (stdio or http) each file's describe.each
# exercises, via the INTEGRATION_TEST_TRANSPORT env var read by
# tests/harness/transports.ts.
#
# Both filters are conditionally applied: an empty or literal-env-var-name
# value falls through to "run everything" instead of forcing a filter. The
# `!= "TOOL_GROUP"` / `!= "TRANSPORT"` guards catch a CI misconfiguration where
# Semaphore's matrix env-var name leaks through uninterpolated; without them,
# vitest would silently match 0 tests (TAG) or activeTransports would throw
# (TRANSPORT). Same idea as vscode's Makefile check on TEST_SUITE.
test-integration:
	@echo "running integration tests: tag=$(TAG) transport=$(TRANSPORT)"
	@if [ -n "$(TAG)" ] && [ "$(TAG)" != "TOOL_GROUP" ]; then \
		TAG_ARG="--tags-filter=$(TAG)"; \
	else \
		TAG_ARG=""; \
	fi; \
	if [ -n "$(TRANSPORT)" ] && [ "$(TRANSPORT)" != "TRANSPORT" ]; then \
		TRANSPORT_ENV="$(TRANSPORT)"; \
	else \
		TRANSPORT_ENV=""; \
	fi; \
	INTEGRATION_TEST_TRANSPORT="$$TRANSPORT_ENV" npm run test:integration -- $$TAG_ARG

# publish junit results to semaphore. mirrors the pattern in
# .semaphore/semaphore.yml's Test block but for the integration junit file.
store-integration-test-results:
	@if [ -f TEST-result.xml ]; then \
		test-results publish TEST-result.xml --name "Integration ($(TAG) / $(TRANSPORT))" --force; \
	else \
		echo "no TEST-result.xml to publish"; \
	fi
