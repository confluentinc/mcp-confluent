# Confluent MCP Server

[![npm version](https://img.shields.io/npm/v/@confluentinc/mcp-confluent.svg)](https://www.npmjs.com/package/@confluentinc/mcp-confluent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An open-source [MCP server](https://modelcontextprotocol.io/) that enables AI assistants to interact with Confluent Cloud, Confluent Platform, and standalone Apache Kafka deployments through natural language.
It provides 50+ tools across Kafka, Flink SQL, Schema Registry, Connectors, Tableflow, and more -- usable from any MCP-compatible client including Claude Desktop, Claude Code, Cursor, VS Code, Goose, and Gemini CLI.

> [!TIP]
> **Already a Confluent Cloud customer?**
> Confluent offers a [fully managed MCP server](https://docs.confluent.io/cloud/current/ai/ai-tools/managed-mcp-server.html) with no local server to run and no dependencies to install.
> It provides access to your Confluent Cloud resources with AI-powered connector diagnostics, governed by your existing RBAC permissions.
> Use this open-source server if you need Confluent Platform / self-managed Kafka support, or want to customize and extend the toolset.

## Quick Start

> **Prerequisites:** [Node.js 22+](https://nodejs.org/).
> If you want to interact with [Confluent Cloud](https://confluent.cloud/), you need to create an account first.

1. Generate a quick `config.yaml` file in your project root:

```bash
npx @confluentinc/mcp-confluent --init-config
```

2. Edit the `config.yaml` file with your connection details, then:

```bash
npx @confluentinc/mcp-confluent --config ./config.yaml
```

See [Getting Started](#getting-started) for full setup instructions and [Configuring MCP Clients](#configuring-mcp-clients) for integration with your preferred AI tool.

## Table of Contents

- [Quick Start](#quick-start)
- [Available Tools](#available-tools)
  - [Always Available](#always-available-tools)
  - [Confluent Cloud](#available-tools-for-confluent-cloud)
  - [Local deployments](#available-tools-for-local-deployments)
- [Using with Confluent Platform](#using-with-confluent-platform)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [OAuth Authentication for Confluent Cloud](#oauth-authentication-for-confluent-cloud)
- [CLI Usage](#cli-usage)
- [Configuring MCP Clients](#configuring-mcp-clients)
- [Telemetry](#telemetry)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## Available Tools

Tools are auto-enabled based on which service blocks are present in your resolved configuration; see [CONFIGURATION.md](CONFIGURATION.md#tool-enablement-which-block-lights-up-what) for the full block-to-tool mapping.

You can list all available tools via the CLI:

```bash
npx -y @confluentinc/mcp-confluent --list-tools
```

### Always-Available Tools

These tools need no service blocks or authentication — they're enabled even on a bare config, regardless of which deployment the rest of your config targets.

| Category          | Tools                                                                                                    | Description                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Documentation** | `search-product-docs`, `get-product-doc-page`                                                            | Search Confluent product docs and fetch full page content                                                                                                                                       |
| **Diagnostics**   | `explain-disabled-tools`, `list-configured-connections`, `config-help`, `describe-configured-connection` | Explain why tools are absent, list configured connections and the tools enabled on each, suggest the YAML to enable a specific tool, and describe one connection's config and tool availability |

### Available Tools for Confluent Cloud

These tools require endpoints and authentication against specific Confluent Cloud components.
Refer to [`config.example.yaml`](config.example.yaml) for the full set of configuration variables.
Categories marked with ¹ also work with [OAuth authentication](#oauth-authentication-for-confluent-cloud) — sign in via your browser instead of provisioning API keys.

| Category                                     | Tools                                                                                                                                                                                                                                                                                                                                          | Description                                                                                |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| **Kafka** ¹                                  | `list-topics`, `create-topics`, `delete-topics`, `produce-message`, `consume-messages`, `search-messages`, `list-consumer-groups`, `describe-consumer-group`, `get-consumer-group-lag`, `alter-topic-config`, `get-topic-config`                                                                                                                                  | Manage topics, produce/consume messages, inspect consumer groups, configure topic settings |
| **Flink SQL** ¹                              | `create-flink-statement`, `list-flink-statements`, `get-flink-statement-results`, `delete-flink-statements`, `get-flink-statement-exceptions`                                                                                                                                                                                                  | Create and manage Flink SQL statements                                                     |
| **Flink Catalog** ¹                          | `list-flink-catalogs`, `list-flink-databases`, `list-flink-tables`, `describe-flink-table`, `get-flink-table-info`                                                                                                                                                                                                                             | Explore Flink catalogs, databases, and table schemas                                       |
| **Flink Diagnostics** ¹                      | `check-flink-statement-health`, `detect-flink-statement-issues`, `get-flink-statement-profile`                                                                                                                                                                                                                                                 | Health checks, issue detection, and query profiling                                        |
| **Connectors** ¹                             | `list-connectors`, `get-connector-config`, `get-connector-offsets`, `get-connector-status`, `get-connector-tasks`, `get-connector-error-summary`, `get-connector-error-recommendations`, `get-connector-logs`, `create-connector` ², `delete-connector`, `pause-connector`, `resume-connector`, `restart-connector`, `update-connector-config` | Inspect and manage Kafka Connect connectors                                                |
| **Schema Registry** ¹                        | `list-schemas`, `create-schema`, `delete-schema`                                                                                                                                                                                                                                                                                               | List, inspect, create, and delete data schemas                                             |
| **Catalog & Tags** ¹                         | `search-topics-by-tag`, `search-topics-by-name`, `create-topic-tags`, `delete-tag`, `remove-tag-from-entity`, `add-tags-to-topic`, `list-tags`                                                                                                                                                                                                 | Organize and search topics using tags                                                      |
| **Organizations, Environments & Clusters** ¹ | `list-organizations`, `list-environments`, `read-environment`, `list-clusters`                                                                                                                                                                                                                                                                 | Discover Confluent Cloud resources                                                         |
| **Tableflow** ¹                              | `create-tableflow-topic`, `list-tableflow-topics`, `read-tableflow-topic`, `update-tableflow-topic`, `delete-tableflow-topic`, `list-tableflow-regions`                                                                                                                                                                                        | Manage Tableflow-enabled topics                                                            |
| **Tableflow Catalog** ¹                      | `create-tableflow-catalog-integration`, `list-tableflow-catalog-integrations`, `read-tableflow-catalog-integration`, `update-tableflow-catalog-integration`, `delete-tableflow-catalog-integration`                                                                                                                                            | Manage Tableflow catalog integrations (e.g., AWS Glue)                                     |
| **Metrics** ¹                                | `list-available-metrics`, `query-metrics`                                                                                                                                                                                                                                                                                                      | Discover and query Confluent Cloud operational metrics                                     |
| **Billing** ¹                                | `list-billing-costs`                                                                                                                                                                                                                                                                                                                           | Query billing and cost data                                                                |

¹ Also available under OAuth — see [OAuth Authentication for Confluent Cloud](#oauth-authentication-for-confluent-cloud) for setup and caveats.
Categories not marked currently require a `direct` connection with static API keys; OAuth migration is in progress.

² Individual tool not available under OAuth; requires a `direct` connection with static API keys.

### Available Tools for local deployments

These tools only require Kafka or Schema Registry endpoints - no Confluent Cloud API key/secret is needed.
Ideal for local development with self-managed clusters, including Confluent Platform.

```yaml
# minimal config.yaml for local development
connections:
  local:
    type: direct
    kafka:
      bootstrap_servers: "localhost:9092"
    schema_registry:
      endpoint: "http://localhost:8081"
```

Ready-to-use variants live in [`sample_configs/`](sample_configs/).

| Category            | Tools                                                                                                                                                                                  | Description                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Kafka**           | `list-topics`, `create-topics`, `delete-topics`, `produce-message`, `consume-messages`, `search-messages`, `list-consumer-groups`, `describe-consumer-group`, `get-consumer-group-lag` | Manage topics, produce/consume/search messages, inspect consumer groups |
| **Schema Registry** | `list-schemas`, `create-schema`, `delete-schema`                                                                                                                                       | List, inspect, create, and delete data schemas                          |

## Using with Confluent Platform

`mcp-confluent` runs against a self-managed Confluent Platform (CP) cluster the same way it runs against any local Kafka + Schema Registry deployment: point a `direct` connection at your brokers and Schema Registry.
A CP connection exposes the same tools as any other local deployment — see [Available Tools for local deployments](#available-tools-for-local-deployments).
The Confluent Cloud tools (Flink, Tableflow, Billing, Metrics, and the rest) require a Confluent Cloud account and stay disabled on CP.
The only differences from a `localhost:9092` setup are authentication and TLS.

### Sample YAML config

[`sample_configs/confluent-platform.yaml`](sample_configs/confluent-platform.yaml) is a copy-pasteable starter.
It assumes PLAIN over SASL_SSL for Kafka and HTTP Basic Auth for Schema Registry.
Customize the broker and Schema Registry URLs, and inject credentials via the `${KAFKA_API_KEY}` / `${KAFKA_API_SECRET}` / `${SCHEMA_REGISTRY_API_KEY}` / `${SCHEMA_REGISTRY_API_SECRET}` environment variables.
If your cluster uses SCRAM or another SASL mechanism, override `security.protocol` and `sasl.mechanisms` through the `kafka.extra_properties` map in that file.

### TLS trust (internal CAs)

CP clusters frequently sit behind an internal CA.
If you see TLS handshake failures against the broker or Schema Registry, point Node at your CA bundle when starting the server:

```bash
NODE_EXTRA_CA_CERTS=/path/to/internal-ca.pem pnpm run start -- --config path/to/config.yaml
```

### End-to-end smoke test

A docker-compose stack ([`docker-compose.cp-test.yml`](docker-compose.cp-test.yml)) brings up a local CP Kafka (KRaft, SASL_PLAINTEXT/PLAIN) plus an unauthenticated Schema Registry.
The matching integration tests are tagged `@cp` and live next to their handlers as `*.cp.integration.test.ts`:

```bash
docker compose -f docker-compose.cp-test.yml up -d
# Wait ~30s for Kafka + SR to become ready, then:
CP_KAFKA_USERNAME=mcp CP_KAFKA_PASSWORD=mcp-secret \
  pnpm run test:integration -- --tags-filter=@cp
docker compose -f docker-compose.cp-test.yml down -v
```

The tests skip cleanly when those env vars are unset, so `pnpm run test:unit` and a default `pnpm run test:integration` against your real Confluent Cloud account are unaffected if you don't have the docker stack running.

## Getting Started

### Prerequisites

- **Node.js 22 or later** -- we recommend using [NVM](https://github.com/nvm-sh/nvm) to manage versions:
  ```bash
  nvm install 22
  nvm use 22
  ```
- **[pnpm](https://pnpm.io/installation)** -- only needed to build from source (the `npx` quick start above does not require it).
  On macOS the simplest install is Homebrew; `npm` works cross-platform:
  ```bash
  brew install pnpm        # macOS
  # or, cross-platform:
  npm install -g pnpm
  ```
  See pnpm's [installation guide](https://pnpm.io/installation) for other options.
  The exact pnpm version is pinned in the `packageManager` field of `package.json`, and pnpm automatically runs that pinned version (via its built-in package-manager version management), so a recent pnpm install is all you need -- no separate Corepack setup required.
- A local environment with Kafka or Schema Registry running, or a **Confluent Cloud** account with appropriate API keys or login credentials if [using OAuth to authenticate](#oauth-authentication-for-confluent-cloud).

### General Setup Steps

This MCP server is designed to be used with various MCP clients, such as Claude Desktop, Copilot, or Goose CLI/Desktop.
The specific configuration and interaction will depend on the client you are using.

The MCP server can authenticate to Confluent Cloud via **OAuth (PKCE)** in addition to static API keys defined in the YAML config.
See [OAuth Authentication For Confluent Cloud](#oauth-authentication-for-confluent-cloud) for more details.

The general steps to configure (if not using OAuth) and run this MCP are:

1. **Create a configuration file:** Copy the provided [`config.yaml` example](https://github.com/confluentinc/mcp-confluent/blob/main/config.example.yaml) file to the root of your project.
   You can use the CLI to bootstrap one in your current directory — no git checkout required:

```bash
npx @confluentinc/mcp-confluent --init-config
```

2. **Populate the file:** Fill in the necessary values for your Confluent Cloud environment.
   See [CONFIGURATION.md](CONFIGURATION.md) for the full reference; only fill in the service blocks you need (each one enables a group of tools).

3. **Start the Server:** You can run the MCP server in one of two ways:
   - **From source:** Follow the instructions in the [Contributing Guide](CONTRIBUTING.md) to build and run the server from source.
     This typically involves:
     - Installing dependencies (`pnpm install`)
     - Building the project (`pnpm run build` or `pnpm run dev`)
   - **With npx:** You can start the server directly using npx, no build required:

     ```bash
     npx @confluentinc/mcp-confluent --config /path/to/myconfig.yaml
     ```

4. **Configure your MCP Client:** Each client (e.g., Claude, Goose) will have its own way of specifying the MCP server's address and any required credentials.
   You'll need to [configure your client](#configuring-mcp-clients) to connect to the address where this server is running (likely `localhost` with a specific port).
   The port the server runs on is set via `server.http.port` in `config.yaml`.

5. **Start your MCP Client:** Once your client is configured to connect to the MCP server, you can start your MCP client and on startup it will stand up an instance of this MCP server locally.
   This instance will be responsible for managing data schemas and interacting with resources on your behalf.

6. **Interact with your resources through the Client:** Once the client is connected and configured, you can use the client's interface to interact with Confluent Cloud or local resources.
   The client will send requests to this MCP server, which will then interact with the available connections on your behalf.

## Configuration

The full configuration reference — YAML schema, every service block, env-var interpolation, OAuth and HTTP/SSE auth setup, the (deprecated) legacy env-var table, and tool-to-block mapping — lives in [CONFIGURATION.md](CONFIGURATION.md).

> **Compatibility note.** This release ships full parity between YAML (`-c config.yaml`) and the legacy env-var path (`-e config.env`) for a single connection.
> The env-var-only path will emit a startup warning in a near-future release and be removed a release or two later.
> Defining multiple connections (or none) is YAML-only — the env-var path can express only a single connection.
> See [CONFIGURATION.md → Two paths, one configuration](CONFIGURATION.md#two-paths-one-configuration) and [CONFIGURATION.md → Multiple connections (and zero connections)](CONFIGURATION.md#multiple-connections-and-zero-connections).

### Prerequisites & setup for Tableflow commands

Tableflow tools interact with cloud storage (e.g. AWS S3) and a metadata catalog (e.g. AWS Glue) on your behalf via the Flink runtime in Confluent Cloud.
The Flink runtime needs IAM permissions on your cloud account, and those have to be granted and linked into Confluent Cloud before any Tableflow tool will succeed.

Follow the **[Tableflow quick start with custom storage & Glue](https://docs.confluent.io/cloud/current/topics/tableflow/get-started/quick-start-custom-storage-glue.html)** to set up the roles, policies, and provider integrations.
Skipping this step leads to authorization errors when mcp-confluent tries to provision or manage Tableflow-enabled tables.

## OAuth Authentication for Confluent Cloud

The MCP server can authenticate to Confluent Cloud via **OAuth (PKCE)** instead of static API keys.
On the first tool call that needs Confluent access, the server opens your browser to the Confluent Cloud sign-in page; subsequent tool calls reuse the resulting session.
No API keys to provision.

### Setup

```bash
npx @confluentinc/mcp-confluent --init-oauth-config
# edit ./config.yaml if needed, then:
npx @confluentinc/mcp-confluent --config ./config.yaml
```

`--init-oauth-config` drops a starter [`config.oauth.example.yaml`](config.oauth.example.yaml) into `./config.yaml`.
The whole file is essentially:

```yaml
connections:
  ccloud-oauth:
    type: oauth
```

See [CONFIGURATION.md → Authentication modes](CONFIGURATION.md#authentication-modes) for the full schema and ergonomics.

The ¹-marked categories in [Available Tools for Confluent Cloud](#available-tools-for-confluent-cloud) work under OAuth today; everything else still needs a `direct` connection with static API keys.

## CLI Usage

The MCP server provides a flexible command line interface (CLI) for advanced control.
The CLI lets you pick the config file, transports, and fine-tune which tools are enabled or blocked.

### Basic Usage

You can view all CLI options and help with:

```bash
npx @confluentinc/mcp-confluent --help
```

<details>
<summary>Show output</summary>

```bash
Usage: mcp-confluent [options]

Confluent MCP Server - Model Context Protocol implementation for Confluent Cloud

Options:
  -V, --version                    output the version number
  -e, --env-file <path>            Load environment variables from file
  -k, --kafka-config-file <file>   Path to a properties file for configuring kafka clients
  -t, --transport <types>          Transport types (comma-separated list) (choices: "http", "sse", "stdio", default: "stdio")
  --allow-tools <tools>            Comma-separated list of tool names to allow. If provided, takes precedence over --allow-tools-file. Allow-list is applied before block-list.
  --block-tools <tools>            Comma-separated list of tool names to block. If provided, takes precedence over --block-tools-file. Block-list is applied after allow-list.
  --allow-tools-file <file>        File with tool names to allow (one per line). Used only if --allow-tools is not provided. Allow-list is applied before block-list.
  --block-tools-file <file>        File with tool names to block (one per line). Used only if --block-tools is not provided. Block-list is applied after allow-list.
  --list-tools                     Print the final set of enabled tool names (with descriptions) after allow/block filtering and exit. Does not start the server.
  --disable-auth                   Disable authentication for HTTP/SSE transports. WARNING: Only use in development environments.
  --allowed-hosts <hosts>          Comma-separated list of allowed Host header values for DNS rebinding protection.
  --generate-key                   Generate a secure API key for MCP_API_KEY and print it to stdout, then exit.
  -h, --help                       display help for command
```

</details>

### Example: Deploy using all transports

```bash
npx @confluentinc/mcp-confluent -c config.yaml --transport http,sse,stdio
```

<details>
<summary>Show output</summary>

```json
...
{"level":"info","time":"2025-05-14T17:03:02.883Z","pid":47959,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Starting transports: http, sse, stdio"}
{"level":"info","time":"2025-05-14T17:03:02.971Z","pid":47959,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"HTTP transport routes registered"}
{"level":"info","time":"2025-05-14T17:03:02.972Z","pid":47959,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"SSE transport routes registered"}
{"level":"info","time":"2025-05-14T17:03:02.972Z","pid":47959,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"STDIO transport connected"}
{"level":"info","time":"2025-05-14T17:03:03.012Z","pid":47959,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Server listening at http://[::1]:3000"}
{"level":"info","time":"2025-05-14T17:03:03.013Z","pid":47959,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Server listening at http://127.0.0.1:3000"}
{"level":"info","time":"2025-05-14T17:03:03.013Z","pid":47959,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"All transports started successfully"}
```

</details>

### Example: Allow Only Specific Tools

```bash
npx @confluentinc/mcp-confluent -c config.yaml --allow-tools produce-message,consume-messages
```

Only the specified tools will be enabled; all others will be disabled.

### Example: Block Certain Tools

```bash
npx @confluentinc/mcp-confluent -c config.yaml --block-tools produce-message,consume-messages
```

All tools except the specified ones will be enabled.

### Example: Use Tool Lists from Files

You can also maintain allow/block lists in files (one tool name per line):

```bash
npx -y @confluentinc/mcp-confluent -c config.yaml --allow-tools-file allow.txt --block-tools-file block.txt
```

### Example: List All Available Tools

```bash
npx -y @confluentinc/mcp-confluent --list-tools
```

<details>
<summary>Show output</summary>

```text
billing:
  list-billing-costs: Retrieve billing cost data for a Confluent Cloud organization within a specified date range with pagination support

catalog:
  add-tags-to-topic: Assign existing tags to Kafka topics in Confluent Cloud.
  create-topic-tags: Create new tag definitions in Confluent Cloud.
  delete-tag: Delete a tag definition from Confluent Cloud.
  list-tags: Retrieve all tags with definitions from Confluent Cloud Schema Registry.
  remove-tag-from-entity: Remove tag from an entity in Confluent Cloud.
  search-topics-by-name: List all topics in the Kafka cluster matching the specified name.
  search-topics-by-tag: List all topics in the Kafka cluster with the specified tag.

confluent-cloud:
  list-clusters: Get all clusters in the Confluent Cloud environment
  list-environments: Get all environments in Confluent Cloud with pagination support
  list-organizations: List Confluent Cloud organizations the current credentials can see. Paginated; if the response includes a nextPageTok...
  read-environment: Get details of a specific environment by ID

connect:
  create-connector: Create a new connector. Returns the new connector information if successful.
  delete-connector: Delete an existing connector. Returns success message if deletion was successful.
  get-connector-config: Retrieve the full configuration map for a connector. Returns the flat config object the connector was created/updated...
  get-connector-error-recommendations: Get suggested remediation steps for a connector that has failed or is in an error state. Returns a one-liner when no recommendations are available.
  get-connector-error-summary: Summarize a connector's current errors. Projects Confluent Cloud's /status diagnostics into a compact, agent-friendly form. Returns a one-liner when the connector is healthy.
  get-connector-logs: Retrieve recent log entries for a Confluent Cloud connector from the Cloud logging API. Defaults to the last hour of ERROR-level entries. Paginated via nextPageToken.
  get-connector-offsets: Retrieve current offsets for a connector's tasks. Useful for detecting lag, stalled tasks, or assisting recovery.
  get-connector-status: Get the current state of a connector and its tasks (RUNNING, FAILED, PAUSED, UNASSIGNED) including failure traces if ...
  get-connector-tasks: List the tasks of a connector along with their configurations.
  list-connectors: Retrieve a list of "names" of the active connectors. You can then make a read request for a specific connector by name.
  pause-connector: Pause a running connector and its tasks. Idempotent.
  restart-connector: Restart a connector and its tasks. Asynchronous; the connector will not transition state synchronously.
  resume-connector: Resume a paused connector and its tasks. Idempotent.
  update-connector-config: Update the configuration of an existing connector. Full-replace: omitted keys are removed and the connector is reconf...

docs:
  get-product-doc-page: Fetch the full markdown content of a Confluent product documentation page. Accepts URLs under https://docs.confluent....
  search-product-docs: Search Confluent product documentation (docs.confluent.io, developer.confluent.io, support.confluent.io) by keyword.

flink:
  check-flink-statement-health: Perform an aggregate health check for a Flink SQL statement. Returns status (healthy/warning/critical), current phase...
  create-flink-statement: Make a request to create a statement.
  delete-flink-statements: Make a request to delete a statement.
  describe-flink-table: Get full schema details for a Flink table via INFORMATION_SCHEMA.COLUMNS. Returns column names, data types (including...
  detect-flink-statement-issues: Detect issues for a Flink SQL statement by analyzing status, exceptions, and performance metrics. Identifies problems...
  get-flink-statement-exceptions: Retrieve the 10 most recent exceptions for a Flink SQL statement. Useful for diagnosing failed or failing statements.
  get-flink-statement-profile: Get Query Profiler data for a Flink SQL statement. Returns the task graph with human-readable task/operator names, pe...
  get-flink-statement-results: Fetch the result rows produced by a Flink SQL statement.
  get-flink-table-info: Get table metadata via INFORMATION_SCHEMA.TABLES. Returns watermark configuration, distribution info, and table type.
  list-flink-catalogs: List all catalogs available in the Flink environment via INFORMATION_SCHEMA.CATALOGS.
  list-flink-databases: List all databases (schemas) in a Flink catalog via INFORMATION_SCHEMA.SCHEMATA. Returns catalog and database names.
  list-flink-statements: Retrieve a sorted, filtered, paginated list of all statements.
  list-flink-tables: List all tables in a Flink database via INFORMATION_SCHEMA.TABLES. Returns table names and types.

kafka:
  alter-topic-config: Alter topic configuration in Confluent Cloud.
  consume-messages: Consume messages from Kafka topics. Optionally restrict to a partition, start from an offset, timestamp, earliest, la...
  create-topics: Create one or more Kafka topics with an optional partition count and replication factor.
  delete-topics: Delete the topic with the given names.
  describe-consumer-group: Describe a single consumer group on a Kafka cluster. Returns the group's state, type, protocol, partition assignor, c...
  get-consumer-group-lag: Compute live offset lag for a single Kafka consumer group. Returns per-(topic, partition) {committedOffset, highWater...
  get-partition-offsets: Return per-partition low/high watermarks and message counts for a Kafka topic. Use this to size a backfill, measure l...
  get-topic-config: Retrieve configuration details for a specific Kafka topic.
  list-consumer-groups: List consumer groups on a Kafka cluster — wraps the broker's listGroups admin call. Optional filters narrow the resul...
  list-topics: List all topics in the Kafka cluster.
  produce-message: Produce records to a Kafka topic. Supports Confluent Schema Registry serialization (AVRO, JSON, PROTOBUF) for both ke...
  search-messages: Full-text search across the messages of one or more Kafka topics. Scans up to `maxScanned` messages from earliest acro...

mcp-server-diagnostics:
  config-help: Call when the user wants to enable or unlock a specific tool (e.g. "how do I enable the tableflow tools?", "what config does cr...
  explain-disabled-tools: Call when the user asks why a tool is missing or unavailable (e.g., "why can't I list Kafka topics?", "where are the ...
  list-configured-connections: List every configured connection and the connection-routable tools you can invoke against each. The connection id (th...

metrics:
  list-available-metrics: List available Confluent Cloud metrics and their filter fields from the Telemetry API. Use this tool BEFORE query-met...
  query-metrics: Query Confluent Cloud metrics from the Telemetry API. IMPORTANT: Use the list-available-metrics tool first to discove...

schema-registry:
  create-schema: Register a new schema (or a new version of an existing schema) under a subject in the Schema Registry.
  delete-schema: Delete a schema subject or a specific version from the Schema Registry. If version is omitted, all versions of the su...
  list-schemas: List all schemas in the Schema Registry.

tableflow:
  create-tableflow-catalog-integration: Make a request to create a catalog integration.
  create-tableflow-topic: Make a request to create a tableflow topic.
  delete-tableflow-catalog-integration: Make a request to delete a tableflow catalog integration.
  delete-tableflow-topic: Make a request to delete a tableflow topic.
  list-tableflow-catalog-integrations: Retrieve a sorted, filtered, paginated list of all catalog integrations.
  list-tableflow-regions: Retrieve a sorted, filtered, paginated list of all tableflow regions.
  list-tableflow-topics: Retrieve a sorted, filtered, paginated list of all tableflow topics.
  read-tableflow-catalog-integration: Make a request to read a catalog integration.
  read-tableflow-topic: Make a request to read a tableflow topic.
  update-tableflow-catalog-integration: Make a request to update a catalog integration.
  update-tableflow-topic: Make a request to update a tableflow topic.
```

</details>

> **Tip:** The allow-list is applied before the block-list.
> If neither is provided, all tools are enabled by default.

## Configuring MCP Clients

Please refer to the following guides for step-by-step instructions on setting up and using this MCP server with your preferred client:

- [Claude Code](docs/configuring-claude-code.md)
- [Claude Desktop](docs/configuring-claude-desktop.md)
- [Cursor](docs/configuring-cursor.md)
- [Gemini CLI](docs/configuring-gemini-cli.md)
- [Goose CLI](docs/configuring-goose-cli.md)
- [IBM Bob](docs/configuring-ibm-bob.md)
- [VS Code](docs/configuring-vs-code.md)
- [Windsurf](docs/configuring-windsurf.md)

## Telemetry

This MCP server collects usage data to help make improvements.
You can opt out by setting `DO_NOT_TRACK=true` in your environment.
See [telemetry.md](telemetry.md) for full details on what is collected.

## Troubleshooting

**"Node.js version not supported"** -- This project requires Node.js 22 or later.
Check your version with `node -v` and upgrade if needed.

**Tools not appearing** -- Each tool requires specific service blocks in your `config.yaml`.
Run `--list-tools` to see which tools are active, or invoke the `explain-disabled-tools` MCP tool from your client for a per-tool reason.
The block-to-tool mapping lives in [CONFIGURATION.md](CONFIGURATION.md#tool-enablement-which-block-lights-up-what).

**Authentication errors on HTTP/SSE** -- Generate an API key with `npx @confluentinc/mcp-confluent --generate-key` and add it to your `config.yaml` under `server.auth.api_key`.
See [CONFIGURATION.md → HTTP/SSE transport security](CONFIGURATION.md#httpsse-transport-security).

**Connection refused / port conflicts** -- The default HTTP port is 8080.
Set `server.http.port` in your `config.yaml` to change it.

**Tableflow authorization errors** -- Tableflow tools require specific IAM permissions in your cloud environment.
See [Prerequisites & setup for Tableflow commands](#prerequisites--setup-for-tableflow-commands).

## Contributing

Bug reports and feedback is appreciated in the form of Github Issues.
For guidelines on contributing please see [CONTRIBUTING.md](CONTRIBUTING.md)

### Pre-release testing

To run the MCP server against a pre-release version for beta testing or early feedback, download the release tarball file to a local directory.
Then, when running any of the `npx` commands above, replace `@confluentinc/mcp-confluent` with the path to that tarball, e.g. `npx @~path/to/my/tarball --list-tools`
