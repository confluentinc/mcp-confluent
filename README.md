# Confluent MCP Server

[![npm version](https://img.shields.io/npm/v/@confluentinc/mcp-confluent.svg)](https://www.npmjs.com/package/@confluentinc/mcp-confluent)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An open-source [MCP server](https://modelcontextprotocol.io/) that enables AI assistants to interact with Confluent Cloud and Confluent Local through natural language. It provides 50+ tools across Kafka, Flink SQL, Schema Registry, Connectors, Tableflow, and more -- usable from any MCP-compatible client including Claude Desktop, Claude Code, Cursor, VS Code, Goose, and Gemini CLI.

## Quick Start

> **Prerequisites:** [Node.js 22+](https://nodejs.org/). If you want to interact with [Confluent Cloud](https://confluent.cloud/), you need to create an account first.

```bash
# Install and run
npx -y @confluentinc/mcp-confluent -e /path/to/.env
```

Or install the [npm package](https://www.npmjs.com/package/@confluentinc/mcp-confluent) directly. See [Getting Started](#getting-started) for full setup instructions and [Configuring MCP Clients](#configuring-mcp-clients) for integration with your preferred AI tool.

## Table of Contents

- [Quick Start](#quick-start)
- [Available Tools](#available-tools)
  - [Confluent Cloud](#available-tools-for-confluent-cloud)
  - [Confluent Local](#available-tools-for-confluent-local)
- [User Guide](#user-guide)
  - [Getting Started](#getting-started)
  - [Configuration](#configuration)
    - [YAML Configuration](#yaml-configuration)
  - [Authentication for HTTP/SSE Transports](#authentication-for-httpsse-transports)
  - [Usage](#usage)
  - [CLI Usage](#cli-usage)
  - [Configuring MCP Clients](#configuring-mcp-clients)
- [Telemetry](#telemetry)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)

## Available Tools

Only the tools whose required environment variables are configured will be enabled. You can also list all available tools via the CLI:

```bash
npx -y @confluentinc/mcp-confluent --list-tools
```

### Available Tools for Confluent Cloud

These tools require endpoints and authentication against specific Confluent Cloud components. Refer to [`.env.example`](.env.example) for the full set of configuration variables.

| Category                    | Tools                                                                                                                                                                                               | Description                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Kafka**                   | `list-topics`, `create-topics`, `delete-topics`, `produce-message`, `consume-messages`, `alter-topic-config`, `get-topic-config`                                                                    | Manage topics, produce/consume messages, configure topic settings |
| **Flink SQL**               | `create-flink-statement`, `list-flink-statements`, `read-flink-statement`, `delete-flink-statements`, `get-flink-statement-exceptions`                                                              | Create and manage Flink SQL statements                            |
| **Flink Catalog**           | `list-flink-catalogs`, `list-flink-databases`, `list-flink-tables`, `describe-flink-table`, `get-flink-table-info`                                                                                  | Explore Flink catalogs, databases, and table schemas              |
| **Flink Diagnostics**       | `check-flink-statement-health`, `detect-flink-statement-issues`, `get-flink-statement-profile`                                                                                                      | Health checks, issue detection, and query profiling               |
| **Connectors**              | `list-connectors`, `read-connector`, `create-connector`, `delete-connector`                                                                                                                         | Manage Kafka Connect connectors                                   |
| **Schema Registry**         | `list-schemas`, `delete-schema`                                                                                                                                                                     | List, inspect, and delete data schemas                            |
| **Catalog & Tags**          | `search-topics-by-tag`, `search-topics-by-name`, `create-topic-tags`, `delete-tag`, `remove-tag-from-entity`, `add-tags-to-topic`, `list-tags`                                                      | Organize and search topics using tags                             |
| **Environments & Clusters** | `list-environments`, `read-environment`, `list-clusters`                                                                                                                                            | Discover Confluent Cloud resources                                |
| **Tableflow**               | `create-tableflow-topic`, `list-tableflow-topics`, `read-tableflow-topic`, `update-tableflow-topic`, `delete-tableflow-topic`, `list-tableflow-regions`                                             | Manage Tableflow-enabled topics                                   |
| **Tableflow Catalog**       | `create-tableflow-catalog-integration`, `list-tableflow-catalog-integrations`, `read-tableflow-catalog-integration`, `update-tableflow-catalog-integration`, `delete-tableflow-catalog-integration` | Manage Tableflow catalog integrations (e.g., AWS Glue)            |
| **Metrics**                 | `list-available-metrics`, `query-metrics`                                                                                                                                                           | Discover and query Confluent Cloud operational metrics            |
| **Billing**                 | `list-billing-costs`                                                                                                                                                                                | Query billing and cost data                                       |

### Available Tools for Confluent Local

These tools only require Kafka or Schema Registry endpoints - no Confluent Cloud API key/secret is needed. Ideal for local development with Docker Compose or self-managed clusters.

```properties
# minimal .env for local development
BOOTSTRAP_SERVERS="localhost:9092"
SCHEMA_REGISTRY_ENDPOINT="http://localhost:8081"
```

| Category            | Tools                                                                                  | Description                             |
| ------------------- | -------------------------------------------------------------------------------------- | --------------------------------------- |
| **Kafka**           | `list-topics`, `create-topics`, `delete-topics`, `produce-message`, `consume-messages` | Manage topics, produce/consume messages |
| **Schema Registry** | `list-schemas`, `delete-schema`                                                        | List, inspect, and delete data schemas  |

## User Guide

### Getting Started

#### Prerequisites

- **Node.js 22 or later** -- we recommend using [NVM](https://github.com/nvm-sh/nvm) to manage versions:
  ```bash
  nvm install 22
  nvm use 22
  ```
- A **Confluent Cloud** account with appropriate API keys

#### Setup

1. **Create a `.env` file:** Copy the provided `.env.example` file to `.env` in the root of your project:
   ```bash
   cp .env.example .env
   ```
2. **Populate the `.env` file:** Fill in the necessary values for your Confluent Cloud environment. See the [Configuration](#configuration) section for details on each variable.

### Configuration

You can configure the MCP server using the following environment variables:

| Variable                      | Description                                                                                                                                                                                                                                                       | Default Value                           | Required |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------- |
| HTTP_HOST                     | Host to bind for HTTP transport. Defaults to localhost only for security.                                                                                                                                                                                         | "127.0.0.1"                             | Yes      |
| HTTP_MCP_ENDPOINT_PATH        | HTTP endpoint path for MCP transport (e.g., '/mcp') (string)                                                                                                                                                                                                      | "/mcp"                                  | Yes      |
| HTTP_PORT                     | Port to use for HTTP transport (number (min: 0))                                                                                                                                                                                                                  | 8080                                    | Yes      |
| LOG_LEVEL                     | Log level for application logging (trace, debug, info, warn, error, fatal)                                                                                                                                                                                        | "info"                                  | Yes      |
| MCP_API_KEY                   | API key for HTTP/SSE authentication. Generate using `--generate-key`. Required when auth is enabled.                                                                                                                                                              |                                         | No\*     |
| MCP_AUTH_DISABLED             | Disable authentication for HTTP/SSE transports. WARNING: Only use in development environments.                                                                                                                                                                    | false                                   | No       |
| MCP_ALLOWED_HOSTS             | Comma-separated list of allowed Host header values for DNS rebinding protection.                                                                                                                                                                                  | "localhost,127.0.0.1"                   | No       |
| SSE_MCP_ENDPOINT_PATH         | SSE endpoint path for establishing SSE connections (e.g., '/sse', '/events') (string)                                                                                                                                                                             | "/sse"                                  | Yes      |
| SSE_MCP_MESSAGE_ENDPOINT_PATH | SSE message endpoint path for receiving messages (e.g., '/messages', '/events/messages') (string)                                                                                                                                                                 | "/messages"                             | Yes      |
| BOOTSTRAP_SERVERS             | List of Kafka broker addresses in the format host1:port1,host2:port2 used to establish initial connection to the Kafka cluster (string)                                                                                                                           |                                         | No       |
| CONFLUENT_CLOUD_API_KEY       | Master API key for Confluent Cloud platform administration, enabling management of resources across your organization (string (min: 1))                                                                                                                           |                                         | No       |
| CONFLUENT_CLOUD_API_SECRET    | Master API secret paired with CONFLUENT_CLOUD_API_KEY for comprehensive Confluent Cloud platform administration (string (min: 1))                                                                                                                                 |                                         | No       |
| CONFLUENT_CLOUD_REST_ENDPOINT | Base URL for Confluent Cloud's REST API services (default)                                                                                                                                                                                                        | https://api.confluent.cloud             | No       |
| FLINK_API_KEY                 | Authentication key for accessing Confluent Cloud's Flink services, including compute pools and SQL statement management (string (min: 1))                                                                                                                         |                                         | No       |
| FLINK_API_SECRET              | Secret token paired with FLINK_API_KEY for authenticated access to Confluent Cloud's Flink services (string (min: 1))                                                                                                                                             |                                         | No       |
| FLINK_COMPUTE_POOL_ID         | Unique identifier for the Flink compute pool, must start with 'lfcp-' prefix (string)                                                                                                                                                                             |                                         | No       |
| FLINK_DATABASE_NAME           | Name of the associated Kafka cluster used as a database reference in Flink SQL operations (string (min: 1))                                                                                                                                                       |                                         | No       |
| FLINK_ENV_ID                  | Unique identifier for the Flink environment, must start with 'env-' prefix (string)                                                                                                                                                                               |                                         | No       |
| FLINK_ENV_NAME                | Human-readable name for the Flink environment used for identification and display purposes (string (min: 1))                                                                                                                                                      |                                         | No       |
| FLINK_ORG_ID                  | Organization identifier within Confluent Cloud for Flink resource management (string (min: 1))                                                                                                                                                                    |                                         | No       |
| FLINK_REST_ENDPOINT           | Base URL for Confluent Cloud's Flink REST API endpoints used for SQL statement and compute pool management (string)                                                                                                                                               |                                         | No       |
| KAFKA_API_KEY                 | Authentication credential (username) required to establish secure connection with the Kafka cluster (string (min: 1))                                                                                                                                             |                                         | No       |
| KAFKA_API_SECRET              | Authentication credential (password) paired with KAFKA_API_KEY for secure Kafka cluster access (string (min: 1))                                                                                                                                                  |                                         | No       |
| KAFKA_CLUSTER_ID              | Unique identifier for the Kafka cluster within Confluent Cloud ecosystem (string (min: 1))                                                                                                                                                                        |                                         | No       |
| KAFKA_ENV_ID                  | Environment identifier for Kafka cluster, must start with 'env-' prefix (string)                                                                                                                                                                                  |                                         | No       |
| KAFKA_REST_ENDPOINT           | REST API endpoint for Kafka cluster management and administration (string)                                                                                                                                                                                        |                                         | No       |
| SCHEMA_REGISTRY_API_KEY       | Authentication key for accessing Schema Registry services to manage and validate data schemas (string (min: 1))                                                                                                                                                   |                                         | No       |
| SCHEMA_REGISTRY_API_SECRET    | Authentication secret paired with SCHEMA_REGISTRY_API_KEY for secure Schema Registry access (string (min: 1))                                                                                                                                                     |                                         | No       |
| SCHEMA_REGISTRY_ENDPOINT      | URL endpoint for accessing Schema Registry services to manage data schemas (string)                                                                                                                                                                               |                                         | No       |
| TABLEFLOW_API_KEY             | Authentication key for accessing Confluent Cloud's Tableflow services (string (min: 1))                                                                                                                                                                           |                                         | No       |
| TABLEFLOW_API_SECRET          | Authentication secret paired with TABLEFLOW_API_KEY for secure Tableflow access (string (min: 1))                                                                                                                                                                 |                                         | No       |
| TELEMETRY_ENDPOINT            | Base URL for Confluent Cloud Telemetry API (metrics)                                                                                                                                                                                                              | "https://api.telemetry.confluent.cloud" | No       |
| TELEMETRY_API_KEY             | Optional API key for telemetry access. Falls back to CONFLUENT_CLOUD_API_KEY if not set. (See [Metrics API authentication docs](https://docs.confluent.io/cloud/current/monitoring/metrics-api.html#create-an-api-key-to-authenticate-to-the-metrics-api).)       |                                         | No       |
| TELEMETRY_API_SECRET          | Optional API secret for telemetry access. Falls back to CONFLUENT_CLOUD_API_SECRET if not set. (See [Metrics API authentication docs](https://docs.confluent.io/cloud/current/monitoring/metrics-api.html#create-an-api-key-to-authenticate-to-the-metrics-api).) |                                         | No       |
| DO_NOT_TRACK                  | Set to `true` to opt out of anonymous telemetry data collection. See [Telemetry](#telemetry) for details.                                                                                                                                                         |                                         | No       |

### YAML Configuration

> **Note:** YAML-based configuration is actively being built out as the replacement for env-var-only startup. The two modes coexist during the transition — the server accepts both.

Pass a YAML config file at startup with the `--config` flag:

```bash
npx @confluentinc/mcp-confluent --config /path/to/myconfig.yaml
```

#### Why YAML over environment variables

Flat environment variables can only express a single implicit connection. A YAML file can define multiple named connections, which is necessary for real-world workflows — for example, a `local-dev` connection pointing at a local Docker Kafka alongside a `staging` connection to a Confluent Cloud cluster, all in one file.

#### Configuration examples

Browse [test-fixtures/yaml_configs/valid/](test-fixtures/yaml_configs/valid/) for working examples covering a range of configurations. These files are executed as part of the test suite on every CI run, so they are always valid and current — use them as your starting point.

#### Env-var interpolation in YAML

`${VAR}` and `${VAR:-default}` syntax is supported anywhere in a config file, so secrets can stay in environment variables while structure lives in the YAML:

```yaml
connections:
  production:
    type: direct
    kafka:
      bootstrap_servers: "broker.confluent.cloud:9092"
      auth:
        type: api_key
        key: "${KAFKA_API_KEY}"
        secret: "${KAFKA_API_SECRET}"
```

#### Prerequisites & Setup for Tableflow Commands

In order to leverage **Tableflow commands** to interact with your data ecosystem and successfully execute these Tableflow commands and manage resources (e.g., interacting with data storage like AWS S3 and metadata catalogs like AWS Glue), certain **IAM (Identity and Access Management) permissions** and configurations are essential.

It is crucial to set up the necessary roles and policies in your cloud environment (e.g., AWS) and link them correctly within Confluent Cloud. This ensures your Flink SQL cluster, which powers Tableflow, has the required authorization to perform operations on your behalf.

Please refer to the following Confluent Cloud documentation for detailed instructions on setting up these permissions and integrating with custom storage and Glue:

- **Confluent Cloud Tableflow Quick Start with Custom Storage & Glue:**
  [https://docs.confluent.io/cloud/current/topics/tableflow/get-started/quick-start-custom-storage-glue.html](https://docs.confluent.io/cloud/current/topics/tableflow/get-started/quick-start-custom-storage-glue.html)

Ensuring these prerequisites are met will prevent authorization errors when the `mcp-server` attempts to provision or manage Tableflow-enabled tables.

### Authentication for HTTP/SSE Transports

When using HTTP or SSE transports, the MCP server requires API key authentication to prevent unauthorized access and protect against DNS rebinding attacks. This is **enabled by default**.

#### Generating an API Key

Generate a secure API key using the built-in utility:

```bash
npx @confluentinc/mcp-confluent --generate-key
```

This will output a 64-character key generated using secure cryptography:

```
Generated MCP API Key:
================================================================
a1b2c3d4e5f6...your-64-char-key-here...
================================================================

```

#### Configuring Authentication

Add the generated key to your `.env` file:

```properties
# MCP Server Authentication (required for HTTP/SSE transports)
MCP_API_KEY=your-generated-64-char-key-here
```

#### Making Authenticated Requests

Include the API key in the `cflt-mcp-api-Key` header for all HTTP/SSE requests:

```bash
curl -H "cflt-mcp-api-Key: your-api-key" http://localhost:8080/mcp
```

#### DNS Rebinding Protection

The server includes additional protections against DNS rebinding attacks:

- **Host Header Validation**: Only requests with allowed Host headers are accepted

Configure allowed hosts if needed:

```properties
# Allow additional hosts (comma-separated)
MCP_ALLOWED_HOSTS=localhost,127.0.0.1,myhost.local
```

#### Additional security to prevent internet exposure of MCP server

- **Localhost Binding**: Server binds to `127.0.0.1` by default (not `0.0.0.0`)

#### Disabling Authentication (Development Only)

For local development, you can disable authentication:

```bash
# Via CLI flag
npx @confluentinc/mcp-confluent -e .env --transport http --disable-auth

# Or via environment variable
MCP_AUTH_DISABLED=true
```

> [!WARNING]
> Never disable authentication in production or when the server is network-accessible.

### Usage

This MCP server is designed to be used with various MCP clients, such as Claude Desktop or Goose CLI/Desktop. The specific configuration and interaction will depend on the client you are using. However, the general steps are:

1. **Start the Server:** You can run the MCP server in one of two ways:
   - **From source:** Follow the instructions in the [Contributing Guide](CONTRIBUTING.md) to build and run the server from source. This typically involves:
     - Installing dependencies (`npm install`)
     - Building the project (`npm run build` or `npm run dev`)
   - **With npx:** You can start the server directly using npx (no build required):

     ```bash
     npx -y @confluentinc/mcp-confluent -e /path/to/confluent-mcp-server/.env
     ```

2. **Configure your MCP Client:** Each client will have its own way of specifying the MCP server's address and any required credentials. You'll need to configure your client (e.g., Claude, Goose) to connect to the address where this server is running (likely `localhost` with a specific port). The port the server runs on may be configured by an environment variable.

3. **Start the MCP Client:** Once your client is configured to connect to the MCP server, you can start your mcp client and on startup - it will stand up an instance of this MCP server locally. This instance will be responsible for managing data schemas and interacting with Confluent Cloud on your behalf.

4. **Interact with Confluent through the Client:** Once the client is connected, you can use the client's interface to interact with Confluent Cloud resources. The client will send requests to this MCP server, which will then interact with Confluent Cloud on your behalf.

### CLI Usage

The MCP server provides a flexible command line interface (CLI) for advanced configuration and control. The CLI allows you to specify environment files, transports, and fine-tune which tools are enabled or blocked.

#### Basic Usage

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
  --disable-confluent-cloud-tools  Disable all tools that require Confluent Cloud REST APIs (cloud-only tools).
  --disable-auth                   Disable authentication for HTTP/SSE transports. WARNING: Only use in development environments.
  --allowed-hosts <hosts>          Comma-separated list of allowed Host header values for DNS rebinding protection.
  --generate-key                   Generate a secure API key for MCP_API_KEY and print it to stdout, then exit.
  -h, --help                       display help for command
```

</details>

#### Example: Deploy using all transports

```bash
npx @confluentinc/mcp-confluent -e .env --transport http,sse,stdio
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

#### Example: Allow Only Specific Tools

```bash
npx @confluentinc/mcp-confluent -e .env --allow-tools produce-message,consume-messages
```

Only the specified tools will be enabled; all others will be disabled.

#### Example: Block Certain Tools

```bash
npx @confluentinc/mcp-confluent -e .env --block-tools produce-message,consume-messages
```

All tools except the specified ones will be enabled.

#### Example: Use Tool Lists from Files

You can also maintain allow/block lists in files (one tool name per line):

```bash
npx -y @confluentinc/mcp-confluent -e .env --allow-tools-file allow.txt --block-tools-file block.txt
```

#### Example: List All Available Tools

```bash
npx -y @confluentinc/mcp-confluent --list-tools
```

<details>
<summary>Show output</summary>

```text
add-tags-to-topic: Assign existing tags to Kafka topics in Confluent Cloud.
alter-topic-config: Alter topic configuration in Confluent Cloud.
consume-messages: Consumes messages from one or more Kafka topics. Supports automatic deserialization of Schema Registry encoded messag...
create-connector: Create a new connector. Returns the new connector information if successful.
create-flink-statement: Make a request to create a statement.
create-topic-tags: Create new tag definitions in Confluent Cloud.
create-topics: Create one or more Kafka topics.
delete-connector: Delete an existing connector. Returns success message if deletion was successful.
delete-flink-statements: Make a request to delete a statement.
delete-tag: Delete a tag definition from Confluent Cloud.
delete-topics: Delete the topic with the given names.
check-flink-statement-health: Perform an aggregate health check for a Flink SQL statement.
describe-flink-table: Get full schema details for a Flink table via INFORMATION_SCHEMA.COLUMNS.
detect-flink-statement-issues: Detect issues for a Flink SQL statement by analyzing status, exceptions, and metrics.
get-flink-statement-profile: Get Query Profiler data with task graph, metrics, and automated issue detection.
get-flink-table-info: Get table metadata via INFORMATION_SCHEMA.TABLES.
list-flink-catalogs: List all catalogs in the Flink environment.
list-flink-databases: List all databases (schemas) in a Flink catalog via INFORMATION_SCHEMA.SCHEMATA.
list-flink-tables: List all tables in a Flink database.
get-flink-statement-exceptions: Retrieve the 10 most recent exceptions for a Flink SQL statement.
get-topic-config: Retrieve configuration details for a specific Kafka topic.
list-clusters: Get all clusters in the Confluent Cloud environment
list-connectors: Retrieve a list of "names" of the active connectors. You can then make a read request for a specific connector by name.
list-environments: Get all environments in Confluent Cloud with pagination support
list-flink-statements: Retrieve a sorted, filtered, paginated list of all statements.
list-schemas: List all schemas in the Schema Registry.
list-tags: Retrieve all tags with definitions from Confluent Cloud Schema Registry.
list-topics: List all topics in the Kafka cluster.
produce-message: Produce records to a Kafka topic. Supports Confluent Schema Registry serialization (AVRO, JSON, PROTOBUF) for both ke...
read-connector: Get information about the connector.
read-environment: Get details of a specific environment by ID
read-flink-statement: Make a request to read a statement and its results
remove-tag-from-entity: Remove tag from an entity in Confluent Cloud.
search-topics-by-name: List all topics in the Kafka cluster matching the specified name.
search-topics-by-tag: List all topics in the Kafka cluster with the specified tag.
create-tableflow-topic: Make a request to create a tableflow topic.
list-tableflow-regions: Retrieve a sorted, filtered, paginated list of all tableflow regions.
list-tableflow-topics: Retrieve a sorted, filtered, paginated list of all tableflow topics.
read-tableflow-topic: Make a request to read a tableflow topic.
update-tableflow-topic: Make a request to update a tableflow topic.
delete-tableflow-topic: Make a request to delete a tableflow topic.
create-tableflow-catalog-integration: Make a request to create a catalog integration.
list-tableflow-catalog-integrations: Retrieve a sorted, filtered, paginated list of all catalog integrations.
read-tableflow-catalog-integration: Make a request to read a catalog integration.
update-tableflow-catalog-integration: Make a request to update a catalog integration.
delete-tableflow-catalog-integration: Make a request to delete a tableflow catalog integration.
```

</details>

> **Tip:** The allow-list is applied before the block-list. If neither is provided, all tools are enabled by default.

### Configuring MCP Clients

Please refer to the following guides for step-by-step instructions on setting up and using this MCP server with your preferred client:

- [Claude Code](docs/configuring-claude-code.md)
- [Claude Desktop](docs/configuring-claude-desktop.md)
- [Cursor](docs/configuring-cursor.md)
- [Gemini CLI](docs/configuring-gemini-cli.md)
- [Goose CLI](docs/configuring-goose-cli.md)
- [VS Code](docs/configuring-vs-code.md)
- [Windsurf](docs/configuring-windsurf.md)

## Telemetry

This MCP server collects anonymous usage data to help make improvements. No personally identifiable information is collected. You can opt out by setting `DO_NOT_TRACK=true` in your environment. See [telemetry.md](telemetry.md) for full details on what is collected.

## Troubleshooting

**"Node.js version not supported"** -- This project requires Node.js 22 or later. Check your version with `node -v` and upgrade if needed.

**Tools not appearing** -- Ensure the required environment variables for those tools are set in your `.env` file. Tools are only enabled when their dependencies are configured. Run `--list-tools` to see which tools are active.

**Authentication errors on HTTP/SSE** -- Generate an API key with `npx @confluentinc/mcp-confluent --generate-key` and add it to your `.env` file as `MCP_API_KEY`. See [Authentication for HTTP/SSE Transports](#authentication-for-httpsse-transports).

**Connection refused / port conflicts** -- The default HTTP port is 8080. If it's already in use, set a different port via `HTTP_PORT` in your `.env` file.

**Tableflow authorization errors** -- Tableflow tools require specific IAM permissions in your cloud environment. See [Prerequisites & Setup for Tableflow Commands](#prerequisites--setup-for-tableflow-commands).

## Contributing

Bug reports and feedback is appreciated in the form of Github Issues. For guidelines on contributing please see [CONTRIBUTING.md](CONTRIBUTING.md)
