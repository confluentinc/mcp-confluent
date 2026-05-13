# Confluent's Local / OSS MCP Server

All notable changes to this MCP server will be documented in this file.

## Unreleased

### Fixed

- Multiple MCP clients can now connect to the same HTTP or SSE server concurrently. Previously, both transports held a single shared `McpServer` across all sessions, which the MCP SDK rejects with `Already connected to a transport` when a second client tried to handshake. Both transports now create a fresh `McpServer` per session. Closes #122 (HTTP) and #337 (SSE).

### Changed

- Removed `baseUrl` invocation parameter from all tool definitions. Now any API non-defaulting endpoint URLs must be provided through environment variable configuration prior to MCP server startup.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`) for all tools to enable AI clients to distinguish between read-only operations (e.g., `list-topics`) and destructive operations (e.g., `delete-topics`, `delete-schema`).

### Removed

- `--disable-confluent-cloud-tools` CLI flag and its `DISABLE_CONFLUENT_CLOUD_TOOLS` environment variable counterpart have been removed. Tool enablement is now determined entirely by which service blocks are present in the connection configation YAML or the equivalent \*\_KEY and \*\_SECRET environment variables.

### Added

- OAuth (`type: oauth`) as an alternative to API keys (`type: direct`) for Confluent Cloud connections.
  - Tools enabled under OAuth: `list-topics`, `create-topics`, `delete-topics`, `produce-message`, `consume-messages`, `get-topic-config`, `alter-topic-config`, `list-organizations`, `list-environments`, `read-environment`, `list-clusters`, `list-billing-costs`.
- Configuration via YAML file.
  - Details go here eventually.
- `config.example.yaml` template for YAML-based configuration. Users copy it to `config.yaml` to use; `.gitignore` rules for `/*.yaml` and `/*.yml` (with explicit allow-rules for currently-tracked root files) keep personal configs and any other accidental root-level yaml out of git.
- `--init-config` CLI flag bootstraps a starter `./config.yaml` (a copy of the bundled `config.example.yaml`) in the current working directory and idempotently appends it to a sibling `.gitignore` (creating one if needed). Refuses to overwrite an existing `config.yaml`. Lets `npx` users get started without checking out the repo.
- `--init-oauth-config` CLI flag bootstraps a starter `./config.yaml` for OAuth auth (a copy of the bundled `config.oauth.example.yaml`). Same destination and gitignore behavior as `--init-config`; mutually exclusive with it.
- Confluent product documentation tools (support `docs.confluent.io`, `developer.confluent.io`, `support.confluent.io`):
  - `search-product-docs` for keyword search across product docs.
  - `get-product-doc-page` for fetching the full markdown content of a single page.
- New tool `explain-disabled-tools` to diagnose why possible tools are not enabled at this time due to mismatches in configuration.
- `FLINK_CATALOG_NAME` environment variable as the preferred spelling for the Flink catalog name (used as the `sql.current-catalog` property in submitted statements).

### Deprecated

- `FLINK_ENV_NAME` environment variable, in favor of `FLINK_CATALOG_NAME`. Both spellings remain accepted and map to the same internal field; setting both simultaneously throws at startup. Support for `FLINK_ENV_NAME` will be removed in v1.4.0.

## 1.2.1

### Fixed

- Fixed telemetry configuration for production builds

## 1.2.0

### Added

- Confluent Cloud metrics API tools
- Telemetry setup and tool call event tracking
- Local Kafka and Schema Registry connections (most tools now work without `*_API_KEY / *_API_SECRET`, enabling functionality in local dev environments)
- `delete-schema` tool for Schema Registry
- Flink catalog tools and diagnostic capabilities
- `list-billing-costs` tool for Confluent Billing API
- Initial test configuration and SonarQube coverage tracking

### Changed

- Improved README with tools table, local dev section, and client config docs
- Updated package dependencies
