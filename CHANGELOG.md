# Confluent's Local / OSS MCP Server

All notable changes to this MCP server will be documented in this file.

## Unreleased

### Added

#### New Tools / Tool Features

- **`consume-messages` per-topic partition + starting-position controls.** Each `topics[]` entry on the consume tool now accepts an optional `partition` (restrict consumption to a single 0-indexed partition; the other assigned partitions are paused after the first poll so the consumer only delivers records from the requested one) and an optional `start` tagged-union field for picking where to begin: `"earliest"` (partition low watermark, the entire retained history), `"latest"` (high watermark, only newly-produced messages), `{offset: "N"}` (absolute partition offset as a digit-only string so int64 values past JS's 2^53 safe-integer range stay precise; requires `partition`), `{timestamp: ...}` (ISO 8601 string or ms-since-epoch number, broker-resolved per-partition via `admin.fetchTopicOffsetsByTimestamp`), or `{tail: N}` (the N most recent already-written messages on the partition — the handler seeks server-side to `max(lowWatermark, highWatermark - N)` and returns immediately without waiting for new traffic; empty partitions return zero messages without error; requires `partition`). Examples:
  - `{name: "orders", partition: 0, start: {offset: "42"}}` — read partition 0 starting at offset 42.
  - `{name: "orders", start: {timestamp: "2026-05-14T17:00:00Z"}}` — every partition seeks to the broker-resolved offset for that timestamp.
  - `{name: "orders", partition: 0, start: {tail: 50}}` — the last 50 messages already on partition 0, returned without blocking for new writes.
  - `{name: "A", start: "earliest"}, {name: "B", start: "latest"}` — mixed-direction call: topic A replays its history while topic B parks at its high watermark.
- **`get-partition-offsets` tool.** Read-only per-partition watermark lookup for a Kafka topic. Returns `{topicName, partitions: [{partition, lowWatermark, highWatermark, messageCount}]}` with `lowWatermark` / `highWatermark` as strings (int64 precision past JS's 2^53 safe-integer boundary) and `messageCount` as a server-side `BigInt(high) - BigInt(low)` narrowed to `Number`. Optional `partition` arg restricts the response to a single partition; non-existent topic and out-of-range partition both surface clean tool-level errors rather than leaking librdkafka text.
- **`list-consumer-groups` tool.** Read-only enumeration of consumer groups on a Kafka cluster, wrapping the broker's native `listGroups` admin call. Optional `matchStates` (array of TitleCase state names — `Stable`, `Empty`, etc.) and `matchType` (scalar `Classic` | `Consumer`) filter server-side so callers can ask "show me only Stable groups" or "only the orphaned ones" without a second round trip. Per-broker partial failures surface verbatim through the response's `errors` array; total failures (no groups at all) become a tool-level error citing the first broker message.
- **`describe-consumer-group` tool.** Read-only single-group inspector, wrapping the broker's `describeGroups` admin call for one group ID. Returns the group's state, type, protocol, partition assignor, coordinator, and per-member assignment as a flat array of `{topic, partition}` pairs (the raw librdkafka `memberAssignment` / `memberMetadata` Buffers are deliberately dropped — they're protocol-level encoded bytes useless to an LLM, and the per-pair upstream `error` / `leaderEpoch` fields are stripped too). `groupInstanceId` is surfaced only when the member is using static membership; `coordinator.rack` is surfaced only when the broker reports it. Unknown group IDs collapse into the same caller-friendly tool-level error `Consumer group "<id>" not found on this cluster.` across all three broker shapes the handler has observed: a top-level `ERR_GROUP_ID_NOT_FOUND` rejection, a per-group `GroupDescription.error` with that code, and (the path Confluent Cloud actually takes) a successful-shaped tombstone with `state: "Dead"`, no members, and empty `protocol`/`partitionAssignor` strings.
- **`get-consumer-group-lag` tool.** Read-only live offset-lag computation for a single Kafka consumer group, combining `admin.fetchOffsets({groupId})` (committed offsets) with the shared partition-watermark helper (high watermarks) and BigInt-subtracting per partition.
- **Connector inspection tools: four new READ_ONLY views.** `get-connector-config` (flat config map), `get-connector-offsets` (per-task offsets), `get-connector-status` (state + per-task health), and `get-connector-tasks` (per-task configs).
  Three of these expose data the prior `read-connector` tool didn't return at all — offsets, runtime status, and per-task configs — and the model can fetch just the view it needs without paying for fields irrelevant to the question.
  `get-connector-status` also surfaces the connector's resource ID (`lcc-...`) as a top-level `lccId` by requesting `?expand=id`, so downstream "by connectorId" tools (metrics, logs) don't need a separate lookup.

#### New Internals

- **`BaseToolHandler.createStructuredResponse(text, structured)`.** Additive helper that surfaces a tool's machine-readable payload via MCP's [`structuredContent` channel](https://modelcontextprotocol.io/specification/2025-11-25/server/tools), with the text content keeping its human-readable summary role. First adopter is `list-consumer-groups`; the broader migration across paginated list handlers is tracked in #435.
- **Tool category taxonomy.** Each tool is now classified into one of 11 `ToolCategory` values (`kafka`, `flink`, ...) — an operator-facing "what kind of tool is this?" axis, orthogonal to the existing "is this tool enabled?" gating. The category surfaces in three places:
  - As `_meta.category` on every `tools/list` advertisement, so MCP clients (Claude, the inspector, etc.) can group or filter the catalog by functional area.
  - In the `--list-tools` CLI output, which now buckets tools under one section header per category instead of printing them in registry-declaration order.
  - On the `explain-disabled-tools` tool, which gains an optional `group_by: "reason" | "category"` argument (default `"reason"`). Pass `group_by: "category"` to regroup the same diagnostic data by functional area when the operator's question is "what's offline in my Flink setup?" rather than "what config piece is missing?".

### Changed

- **`consume-messages` tool: breaking shape changes alongside the new controls above.**
  - **Top-level `offsetReset` field removed.** Position control is consolidated into the per-topic `start` tagged union (see Added); the consumer-level `auto.offset.reset` is derived from the call. The consolidation enables mixed-direction calls the prior consumer-wide `offsetReset` couldn't express ("topic A from earliest, topic B from latest" in one call now works). The starting-position default stays at `"earliest"` (no behavior change for bare-name calls); pass `start: "latest"` on the topic entries that should read only newly-produced messages.
  - **`value` / `key` deserialization options renamed to `valueFormat` / `keyFormat`.** The old names read as data peers to `topics` (especially `value`, which looks like "the value to produce"); the new names describe what the fields do — the format/encoding of the bytes. Both are also now omit-by-default, so the simple consume call no longer needs `value: {}` filler.
  - **`topicNames: string[]` removed in favor of the richer `topics[]` shape.** The single required field is now `topics`, an array of per-topic option objects. The minimal call is `{topics: [{name: "orders"}]}`; the same array carries optional `partition` and `start` controls on the entries that need them.
  - **Schema Registry decoding now defaults on; opt out per side with `disableSchemaRegistry: true`.** The old useSchemaRegistry: true opt-in is gone; SR decoding now happens automatically by default. Opt out per side with `disableSchemaRegistry: true` on valueFormat / keyFormat.

### Removed

- **`read-connector` tool.** Returned `{name, config, tasks: [id-refs], type}` from `GET /connect/v1/.../connectors/{name}`. Its content is now covered by the more granular tools listed under Added: the config map by `get-connector-config`, the per-task identifiers (and the connector type, derivable from `connector.class`) by `get-connector-tasks`. Callers that previously read the whole blob to pick one field can now ask for just that field.

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
