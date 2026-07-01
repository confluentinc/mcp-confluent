# Confluent's Local / OSS MCP Server

All notable changes to this MCP server will be documented in this file.

## Unreleased

## 1.5.0

### Added

#### New Tools / Tool Features

- **`list-compute-pools` tool.** Read-only discovery tool that lists the Flink compute pools in an environment (id, display name, cloud, region).
- **`create-schema` tool.** Registers a schema (or a new version) under a subject in the Schema Registry, peer to `list-schemas` and `delete-schema`.
- **`list-configured-connections` tool.** Read-only, always-enabled discovery tool describing configured connections (including read-only-ness) and the connection-routable tools enabled for each.
- **`describe-configured-connection` tool.** Read-only, always-enabled discovery tool that, given one connection id, reports its non-secret config (never credentials), read-only-ness, and the tools enabled on it alongside the reason each disabled tool is gated off.
- **`config-help` tool.** Read-only, always-enabled tool that, given a target tool name, reports per connection the config gap keeping that tool disabled and returns a paste-ready YAML snippet to close it — or a note when the fix isn't a block to add (an OAuth or `read_only` connection). Suggests only; it never edits the config file.
- **More tool families now work under OAuth.** Additional Confluent Cloud tool families are now usable from an OAuth (PKCE) connection, not just `direct` connections with static API keys.
  - **Connectors.** All 13 tools except `create-connector` (which stays `direct`-only, since its spec embeds a Kafka API key/secret).
  - **Catalog & Tags.** All 7 tools (`search-topics-by-tag`, `search-topics-by-name`, `create-topic-tags`, `delete-tag`, `remove-tag-from-entity`, `add-tags-to-topic`, `list-tags`).
  - **Metrics.** Both tools (`list-available-metrics`, `query-metrics`).
  - **Tableflow.** All 11 tools (the 6 topic/region tools and the 5 catalog-integration tools).
  - **Flink.** All 13 tools (the 5 statement tools, the 5 catalog tools, and the 3 diagnostics tools).
- **`explain-disabled-tools` now reports per connection.** The "why is this tool missing?" report is split into one section per configured connection, each with its own disabled-tool buckets and counts — so a tool live on one connection and dark on another surfaces under exactly the connection that gates it, rather than being flattened to a single server-wide verdict.
- **`produce-message` improvements:**
  - **Record-level `partition`, `timestamp`, and `headers`.** Three optional arguments for faithfully reproducing a record on another cluster: `partition` (non-negative integer) pins the target partition; `timestamp` accepts a `Date.parse`-able date-time string (ISO 8601 recommended) or a non-negative integer ms-since-epoch number (an unparseable value returns an error instead of silently stamping wall-clock time); `headers` maps a header name to a string or array of strings (multi-valued), carried as raw Kafka headers independent of Schema Registry serialization.
  - **Support for schema-id-in-headers**: The tool can be asked to encode the schema GUID(s) (UUIDs) in the Kafka message headers. By default, however, schema IDs are encoded in the payload's magic-byte prefix (the standard Confluent wire format).
- **`consume-messages` tool** now also supports deserializing records based on schema GUIDs encoded in the message headers (`__value_schema_id` / `__key_schema_id`), and surfaces those header-located schema GUIDs in the returned headers so callers can see which schema each record used.

#### Configuration

- **Per-connection `description` field.** Optional free-text label on any connection, echoed back by `list-configured-connections`.
- **Per-connection `read_only` flag.** Set `read_only: true` on a connection to auto-disable every state-mutating tool for it, leaving only read-only tools enabled. **Defaults to `false`** --- resources reachable by a connection may be mutated or deleted from. The `list-configured-connections` tool reports each connection's read-onlyness.

#### Observability

- **Error reporting (Sentry):** runtime errors are reported to [Sentry](https://sentry.io) (credentials redacted), on by default and disabled by the same `DO_NOT_TRACK` switch as usage analytics. See [telemetry.md](telemetry.md).


### Changed

- **Configuration**: _A YAML config may now define multiple connections — or none._ Point a single `config.yaml` at several clusters at once — for example a local Apache Kafka broker alongside Confluent Cloud — or run with no connection at all (documentation search and server-diagnostic tools still work). At most one of those connections may use OAuth to Confluent Cloud. See [CONFIGURATION.md → Multiple connections (and zero connections)](CONFIGURATION.md#multiple-connections-and-zero-connections).
  - When multiple connections are enabled, all connection-oriented tools will be driven with the connection id the tool should be invoked against, even if said tool was only invokable against a single connection to improve clarity and consistency (such as would be the case for a mutating tool invocation when one connection is marked read_only and the other allows writes).

### Removed

- The deprecated `FLINK_ENV_NAME` environment variable. Use `FLINK_CATALOG_NAME` (or a connection's `flink.catalog_name` in YAML) instead.

### Fixed

- `produce-message` can now produce primitive key and value payloads (numbers, booleans, strings) against top-level primitive Schema Registry schemas such as Avro `long`; previously the serializer rejected anything but an object.
- Introduced new optional tool argument `messageName` to `produce-message` tool to fix producing messages using PROTOBUF as format ([#127](https://github.com/confluentinc/mcp-confluent/issues/127)).
- `explain-disabled-tools` now accounts for tools the operator excluded via `--allow-tools` / `--block-tools`; previously (since v1.3.0) such tools were ignored by the diagnostic, which either counted them as enabled — contradicting `tools/list` — or blamed a missing config block. They now appear in a dedicated server-wide block.

## 1.4.0

### Added

#### New Tools / Tool Features

- **`consume-messages` per-topic `partition` and `start` controls.** Each `topics[]` entry now accepts an optional `partition` (consume a single partition) and an optional `start` position (default `"earliest"`): `"earliest"`, `"latest"`, `{offset: "N"}` (requires `partition`), `{timestamp: ...}` (ISO 8601 or ms-since-epoch), or `{tail: N}` (the N most recent existing messages, returned without waiting for new traffic; requires `partition`). Examples:
  - `{name: "orders", partition: 0, start: {offset: "42"}}` — read partition 0 starting at offset 42.
  - `{name: "orders", start: {timestamp: "2026-05-14T17:00:00Z"}}` — every partition seeks to the broker-resolved offset for that timestamp.
  - `{name: "orders", partition: 0, start: {tail: 50}}` — the last 50 messages already on partition 0, returned without blocking for new writes.
  - `{name: "A", start: "earliest"}, {name: "B", start: "latest"}` — mixed-direction call: topic A replays its history while topic B parks at its high watermark.
- **`get-partition-offsets` tool.** Read-only per-partition low/high watermark and message-count lookup for a Kafka topic; optional `partition` narrows the response.
- **`list-consumer-groups` tool.** Read-only enumeration of a Kafka cluster's consumer groups, with optional server-side `matchStates` / `matchType` filters.
- **`describe-consumer-group` tool.** Read-only inspector for a single group: state, type, protocol, partition assignor, coordinator, and per-member topic/partition assignment.
- **`get-consumer-group-lag` tool.** Read-only per-partition offset lag for a single consumer group (committed offset vs. high watermark).
- **Connector inspection tools (4, read-only):** `get-connector-config`, `get-connector-offsets`, `get-connector-status` (also surfaces the connector's `lcc-...` resource ID as `lccId`), and `get-connector-tasks`.
- **Connector lifecycle tools (4):** `pause-connector`, `resume-connector`, `restart-connector`, and `update-connector-config` (full-replace semantics — omitted keys are removed).
- **Connector error-diagnostics tools (3, read-only):** `get-connector-error-summary`, `get-connector-error-recommendations`, and `get-connector-logs` — for troubleshooting FAILED connectors.

#### New Internals

- **`BaseToolHandler.createStructuredResponse(text, structured)`.** Surfaces a tool's machine-readable payload via MCP's `structuredContent` channel while the text content keeps its human-readable role. First adopter is `list-consumer-groups`; broader migration tracked in #435.
- **Tool category taxonomy.** Each tool is classified into one of 11 `ToolCategory` values, surfaced as `_meta.category` on `tools/list`, as section headers in `--list-tools` output, and via a new optional `group_by: "reason" | "category"` argument on `explain-disabled-tools`.

### Changed

- **`read-flink-statement` tool renamed to `get-flink-statement-results`.** The old name read as a peer to `read-connector` / `read-environment` (fetch the resource), but the tool actually returns a statement's _result rows_, not the statement definition. The new name matches the `get-…` verb the rest of the surface uses for result/data reads. Inputs, output shape, and behavior are unchanged; update any client config that pins the tool by name.
- **`consume-messages`: breaking input-shape changes** alongside the new controls above.
  - `topicNames: string[]` replaced by `topics[]`, an array of per-topic option objects. Minimal call: `{topics: [{name: "orders"}]}`.
  - Top-level `offsetReset` removed; starting position is now per-topic via `start` (default remains `"earliest"`).
  - `value` / `key` deserialization options renamed to `valueFormat` / `keyFormat`, both omit-by-default.
  - Schema Registry decoding is now enabled by default; opt out per side with `disableSchemaRegistry: true` on `valueFormat` / `keyFormat`.

### Removed

- **`read-connector` tool.** Its content is now covered by `get-connector-config` (config map) and `get-connector-tasks` (per-task configs and connector type).

## 1.3.0

### Added

- **OAuth (PKCE) authentication for Confluent Cloud.** A `connections.<id>.type: oauth` connection signs the user in via the Confluent Cloud login page on the first tool call that needs Cloud access, then reuses the session — no static API keys to provision.
  - Currently supported across Kafka (native and REST), Schema Registry, Organizations / Environments / Clusters, and Billing tools; Connect, Tableflow, Flink, Metrics, and Catalog & Tags are still direct-only and being migrated.
  - See [README → OAuth Authentication for Confluent Cloud](README.md#oauth-authentication-for-confluent-cloud) and [CONFIGURATION.md → Authentication modes](CONFIGURATION.md#authentication-modes).
- **YAML-based configuration**, full parity with env-var configuration for a single connection. New CLI flag `-c, --config <path>` parses, `${VAR}`/`${VAR:-default}`-interpolates, and Zod-validates a YAML file into the same `MCPServerConfiguration` the legacy env-var path produces.
  - Per-service blocks (`kafka`, `schema_registry`, `confluent_cloud`, `flink`, `tableflow`, `telemetry`) are independently optional and gate tool enablement. A new top-level `server:` block replaces seven HTTP/SSE/log env vars.
  - Companion files: [`config.example.yaml`](config.example.yaml), [`config.oauth.example.yaml`](config.oauth.example.yaml), and ready-to-use snippets in [`sample_configs/`](sample_configs/). The repo's `/*.yaml` and `/*.yml` gitignore rules keep filled-in copies out of git.
- **New `explain-disabled-tools` tool**: ask the running server why a specific tool isn't on the list and get back the missing YAML block or field, grouped by the gap each disabled tool is waiting on.
- **New `list-organizations` tool**: enumerates the Confluent Cloud organizations the authenticated user can access.
- **Confluent product documentation tools** (covering `docs.confluent.io`, `developer.confluent.io`, `support.confluent.io`):
  - `search-product-docs` for keyword search across product docs.
  - `get-product-doc-page` for fetching the full markdown content of a single page.
- **`FLINK_CATALOG_NAME`** environment variable as the preferred spelling for the Flink catalog name (used as the `sql.current-catalog` property in submitted statements).
- **`--init-config`** CLI flag bootstraps a starter `./config.yaml` from the bundled `config.example.yaml` and idempotently appends it to a sibling `.gitignore` (creating one if needed). Refuses to overwrite an existing `config.yaml`. Lets `npx` users get started without cloning the repo.
- **`--init-oauth-config`** CLI flag, the OAuth analogue of `--init-config`: drops `config.oauth.example.yaml` at the same destination with the same gitignore behavior. Mutually exclusive with `--init-config`.
- **[`CONFIGURATION.md`](CONFIGURATION.md)** as the single configuration reference: YAML schema, every service block, `${VAR}` interpolation, OAuth and HTTP/SSE auth, the legacy env-var table, and the block-to-tool enablement matrix.

### Changed

- Removed `baseUrl` invocation parameter from all tool definitions. Non-default endpoint URLs are now supplied through configuration (YAML or env vars) at startup, not at tool-call time.
- MCP tool annotations (`readOnlyHint`, `destructiveHint`) added to all tools so AI clients can distinguish read-only operations (e.g. `list-topics`) from destructive ones (e.g. `delete-topics`, `delete-schema`).

### Deprecated

- **Env-var-only configuration path.** Setting credentials and endpoints purely via environment variables (no `-c <config.yaml>`) is now considered legacy. Parity with YAML remains for a single connection in this release. A future release will emit a startup warning when the env-var-only path is used; a release or two later, the path will be removed. Env vars continue to work indefinitely as a source for `${VAR}` interpolation inside YAML and as a way to pass linked-library settings (TLS, SASL, Kerberos, proxy) into the process — only their role as the _sole_ config source is going away. **Multi-connection support, slated for the next release, will be YAML-only.** Existing setups are unaffected today; see [CONFIGURATION.md → Two paths, one configuration](CONFIGURATION.md#two-paths-one-configuration) and [CONFIGURATION.md → How env vars and `.env` files fit into the YAML world](CONFIGURATION.md#how-env-vars-and-env-files-fit-into-the-yaml-world).
- `FLINK_ENV_NAME` environment variable, in favor of `FLINK_CATALOG_NAME`. Both spellings remain accepted and map to the same internal field; setting both simultaneously throws at startup. Support for `FLINK_ENV_NAME` will be removed in v1.4.0.

### Removed

- `--disable-confluent-cloud-tools` CLI flag and its `DISABLE_CONFLUENT_CLOUD_TOOLS` env-var counterpart. Tool enablement is now determined entirely by which service blocks are present in the resolved configuration (from YAML, or synthesized from `*_KEY`/`*_SECRET` env vars during the legacy-path deprecation window).

### Fixed

- Multiple MCP clients can now connect to the same HTTP or SSE server concurrently. Previously, both transports held a single shared `McpServer` across all sessions, which the MCP SDK rejects with `Already connected to a transport` when a second client tried to handshake. Both transports now create a fresh `McpServer` per session. Closes #122 (HTTP) and #337 (SSE).

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
