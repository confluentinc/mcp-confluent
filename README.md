# mcp-confluent

An MCP server implementation that enables AI assistants to interact with Confluent Cloud REST APIs. This server allows AI tools like Claude Desktop and Goose CLI to manage Kafka topics, connectors, and Flink SQL statements through natural language interactions.

<a href="https://glama.ai/mcp/servers/@confluentinc/mcp-confluent">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@confluentinc/mcp-confluent/badge" alt="mcp-confluent MCP server" />
</a>

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/confluentinc/mcp-confluent)

## Demo

### Goose CLI

![Goose CLI Demo](assets/goose-cli-demo.gif)

### Claude Desktop

![Claude Desktop Demo](assets/claude-desktop-demo.gif)

## Table of Contents

- [mcp-confluent](#mcp-confluent)
  - [Demo](#demo)
    - [Goose CLI](#goose-cli)
    - [Claude Desktop](#claude-desktop)
  - [Table of Contents](#table-of-contents)
  - [User Guide](#user-guide)
    - [Getting Started](#getting-started)
    - [Configuration](#configuration)
      - [Prerequisites \& Setup for Tableflow Commands](#prerequisites--setup-for-tableflow-commands)
    - [Environment Variables Reference](#environment-variables-reference)
    - [Usage](#usage)
    - [Configuring Claude Desktop](#configuring-claude-desktop)
    - [Configuring Goose CLI](#configuring-goose-cli)
    - [Configuring Gemini CLI](#configuring-gemini-cli)
    - [mcp-confluent CLI Usage](#mcp-confluent-cli-usage)
      - [Basic Usage](#basic-usage)
      - [Example: Deploy using all transports](#example-deploy-using-all-transports)
      - [Example: Allow Only Specific Tools](#example-allow-only-specific-tools)
      - [Example: Block Certain Tools](#example-block-certain-tools)
      - [Example: Use Tool Lists from Files](#example-use-tool-lists-from-files)
      - [Example: List All Available Tools](#example-list-all-available-tools)
  - [Developer Guide](#developer-guide)
    - [Project Structure](#project-structure)
    - [Building and Running](#building-and-running)
    - [Docker](#docker)
      - [Prerequisites](#prerequisites)
        - [Environment Variables](#environment-variables)
      - [Building and Running with Docker](#building-and-running-with-docker)
      - [Building and Running with Docker Compose](#building-and-running-with-docker-compose)
    - [Testing](#testing)
      - [MCP Inspector](#mcp-inspector)
    - [Adding a New Tool](#adding-a-new-tool)
    - [Generating Types](#generating-types)
    - [Contributing](#contributing)

## User Guide

### Getting Started

1. **Create a `.env` file:**  Copy the example `.env` file structure (shown below) into a new file named `.env` in the root of your project.
2. **Populate the `.env` file:** Fill in the necessary values for your Confluent Cloud environment.  See the [Configuration](#configuration) section for details on each variable.
3. **Install Node.js** (if not already installed)
   - We recommend using [NVM](https://github.com/nvm-sh/nvm) (Node Version Manager) to manage Node.js versions
   - Install and use Node.js:

    ```bash
    nvm install 22
    nvm use 22
    ```

### Configuration

Create a `.env` file in the root directory of your project with the following configuration:

<details>
<summary>Example .env file structure</summary>

```properties
# .env file
BOOTSTRAP_SERVERS="pkc-v12gj.us-east4.gcp.confluent.cloud:9092"
KAFKA_API_KEY="..."
KAFKA_API_SECRET="..."
KAFKA_REST_ENDPOINT="https://pkc-v12gj.us-east4.gcp.confluent.cloud:443"
KAFKA_CLUSTER_ID=""
KAFKA_ENV_ID="env-..."
FLINK_ENV_ID="env-..."
FLINK_ORG_ID=""
FLINK_REST_ENDPOINT="https://flink.us-east4.gcp.confluent.cloud"
FLINK_ENV_NAME=""
FLINK_DATABASE_NAME=""
FLINK_API_KEY=""
FLINK_API_SECRET=""
FLINK_COMPUTE_POOL_ID="lfcp-..."
TABLEFLOW_API_KEY=""
TABLEFLOW_API_SECRET=""
CONFLUENT_CLOUD_API_KEY=""
CONFLUENT_CLOUD_API_SECRET=""
CONFLUENT_CLOUD_REST_ENDPOINT="https://api.confluent.cloud"
SCHEMA_REGISTRY_API_KEY="..."
SCHEMA_REGISTRY_API_SECRET="..."
SCHEMA_REGISTRY_ENDPOINT="https://psrc-zv01y.northamerica-northeast2.gcp.confluent.cloud"
CONFLUENT_CLOUD_TELEMETRY_ENDPOINT="https://api.telemetry.confluent.cloud"
```

</details>

#### Prerequisites & Setup for Tableflow Commands

In order to leverage **Tableflow commands** to interact with your data ecosystem and successfully execute these Tableflow commands and manage resources (e.g., interacting with data storage like AWS S3 and metadata catalogs like AWS Glue), certain **IAM (Identity and Access Management) permissions** and configurations are essential.

It is crucial to set up the necessary roles and policies in your cloud environment (e.g., AWS) and link them correctly within Confluent Cloud. This ensures your Flink SQL cluster, which powers Tableflow, has the required authorization to perform operations on your behalf.

Please refer to the following Confluent Cloud documentation for detailed instructions on setting up these permissions and integrating with custom storage and Glue:

- **Confluent Cloud Tableflow Quick Start with Custom Storage & Glue:**
    [https://docs.confluent.io/cloud/current/topics/tableflow/get-started/quick-start-custom-storage-glue.html](https://docs.confluent.io/cloud/current/topics/tableflow/get-started/quick-start-custom-storage-glue.html)

Ensuring these prerequisites are met will prevent authorization errors when the `mcp-server` attempts to provision or manage Tableflow-enabled tables.

### Environment Variables Reference

| Variable                      | Description                                                                                                                               | Default Value | Required |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------- |
| HTTP_HOST                     | Host to bind for HTTP transport. 0.0.0.0 means all interfaces. (string)                                                                   | "0.0.0.0"     | Yes      |
| HTTP_MCP_ENDPOINT_PATH        | HTTP endpoint path for MCP transport (e.g., '/mcp') (string)                                                                              | "/mcp"        | Yes      |
| HTTP_PORT                     | Port to use for HTTP transport (number (min: 0))                                                                                          | 8080          | Yes      |
| LOG_LEVEL                     | Log level for application logging (trace, debug, info, warn, error, fatal) (effects)                                                      | "info"        | Yes      |
| SSE_MCP_ENDPOINT_PATH         | SSE endpoint path for establishing SSE connections (e.g., '/sse', '/events') (string)                                                     | "/sse"        | Yes      |
| SSE_MCP_MESSAGE_ENDPOINT_PATH | SSE message endpoint path for receiving messages (e.g., '/messages', '/events/messages') (string)                                         | "/messages"   | Yes      |
| BOOTSTRAP_SERVERS             | List of Kafka broker addresses in the format host1:port1,host2:port2 used to establish initial connection to the Kafka cluster (string)   |               | No       |
| CONFLUENT_CLOUD_API_KEY       | Master API key for Confluent Cloud platform administration, enabling management of resources across your organization (string (min: 1))   |               | No       |
| CONFLUENT_CLOUD_API_SECRET    | Master API secret paired with CONFLUENT_CLOUD_API_KEY for comprehensive Confluent Cloud platform administration (string (min: 1))         |               | No       |
| CONFLUENT_CLOUD_REST_ENDPOINT | Base URL for Confluent Cloud's REST API services (default)                                                                                |               | No       |
| FLINK_API_KEY                 | Authentication key for accessing Confluent Cloud's Flink services, including compute pools and SQL statement management (string (min: 1)) |               | No       |
| FLINK_API_SECRET              | Secret token paired with FLINK_API_KEY for authenticated access to Confluent Cloud's Flink services (string (min: 1))                     |               | No       |
| FLINK_COMPUTE_POOL_ID         | Unique identifier for the Flink compute pool, must start with 'lfcp-' prefix (string)                                                     |               | No       |
| FLINK_DATABASE_NAME           | Name of the associated Kafka cluster used as a database reference in Flink SQL operations (string (min: 1))                               |               | No       |
| FLINK_ENV_ID                  | Unique identifier for the Flink environment, must start with 'env-' prefix (string)                                                       |               | No       |
| FLINK_ENV_NAME                | Human-readable name for the Flink environment used for identification and display purposes (string (min: 1))                              |               | No       |
| FLINK_ORG_ID                  | Organization identifier within Confluent Cloud for Flink resource management (string (min: 1))                                            |               | No       |
| FLINK_REST_ENDPOINT           | Base URL for Confluent Cloud's Flink REST API endpoints used for SQL statement and compute pool management (string)                       |               | No       |
| KAFKA_API_KEY                 | Authentication credential (username) required to establish secure connection with the Kafka cluster (string (min: 1))                     |               | No       |
| KAFKA_API_SECRET              | Authentication credential (password) paired with KAFKA_API_KEY for secure Kafka cluster access (string (min: 1))                          |               | No       |
| KAFKA_CLUSTER_ID              | Unique identifier for the Kafka cluster within Confluent Cloud ecosystem (string (min: 1))                                                |               | No       |
| KAFKA_ENV_ID                  | Environment identifier for Kafka cluster, must start with 'env-' prefix (string)                                                          |               | No       |
| KAFKA_REST_ENDPOINT           | REST API endpoint for Kafka cluster management and administration (string)                                                                |               | No       |
| SCHEMA_REGISTRY_API_KEY       | Authentication key for accessing Schema Registry services to manage and validate data schemas (string (min: 1))                           |               | No       |
| SCHEMA_REGISTRY_API_SECRET    | Authentication secret paired with SCHEMA_REGISTRY_API_KEY for secure Schema Registry access (string (min: 1))                             |               | No       |
| SCHEMA_REGISTRY_ENDPOINT      | URL endpoint for accessing Schema Registry services to manage data schemas (string)                                                       |               | No       |
| TABLEFLOW_API_KEY             | Authentication key for accessing Confluent Cloud's Tableflow services (string (min: 1))                                                   |               | No       |
| TABLEFLOW_API_SECRET          | Authentication secret paired with TABLEFLOW_API_KEY for secure Tableflow access (string (min: 1))                                         |               | No       |

### Usage

This MCP server is designed to be used with various MCP clients, such as Claude Desktop or Goose CLI/Desktop.  The specific configuration and interaction will depend on the client you are using.  However, the general steps are:

1. **Start the Server:** You can run the MCP server in one of two ways:
   - **From source:** Follow the instructions in the [Developer Guide](#developer-guide) to build and run the server from source. This typically involves:
     - Installing dependencies (`npm install`)
     - Building the project (`npm run build` or `npm run dev`)
   - **With npx:** You can start the server directly using npx (no build required):

     ```bash
     npx -y @confluentinc/mcp-confluent -e /path/to/confluent-mcp-server/.env
     ```

2. **Configure your MCP Client:**  Each client will have its own way of specifying the MCP server's address and any required credentials.  You'll need to configure your client (e.g., Claude, Goose) to connect to the address where this server is running (likely `localhost` with a specific port). The port the server runs on may be configured by an environment variable.

3. **Start the MCP Client:**  Once your client is configured to connect to the MCP server, you can start your mcp client and on startup - it will stand up an instance of this MCP server locally.  This instance will be responsible for managing data schemas and interacting with Confluent Cloud on your behalf.

4. **Interact with Confluent through the Client:** Once the client is connected, you can use the client's interface to interact with Confluent Cloud resources.  The client will send requests to this MCP server, which will then interact with Confluent Cloud on your behalf.

### Configuring Claude Desktop

See [here](https://modelcontextprotocol.io/quickstart/user) for more details about installing Claude Desktop and MCP servers.

To configure Claude Desktop to use this MCP server:

1. **Open Claude Desktop Configuration**
   - On Mac: `~/Library/Application\ Support/Claude/claude_desktop_config.json`
   - On Windows: `%APPDATA%\Claude\claude_desktop_config.json`

2. **Edit Configuration File**
   - Open the config file in your preferred text editor
   - Add or modify the configuration using one of the following methods:

   <details>
   <summary>Option 1: Run from source</summary>

   ```json
   {
     "mcpServers": {
       "confluent": {
         "command": "node",
         "args": [
           "/path/to/confluent-mcp-server/dist/index.js",
            "--env-file",
           "/path/to/confluent-mcp-server/.env"
         ]
       }
     }
   }
   ```

   </details>

   <details>
   <summary>Option 2: Run from npx</summary>

   ```json
   {
     "mcpServers": {
       "confluent": {
         "command": "npx",
         "args": [
           "-y"
           "@confluentinc/mcp-confluent",
           "-e",
           "/path/to/confluent-mcp-server/.env"
         ]
       }
     }
   }
   ```

   </details>

   Replace `/path/to/confluent-mcp-server/` with the actual path where you've installed this MCP server.

1. **Restart Claude Desktop**
   - Close and reopen Claude Desktop for the changes to take effect
   - The MCP server will automatically start when Claude Desktop launches

Now Claude Desktop will be configured to use your local MCP server for Confluent interactions.

![Claude Tools](assets/claude-tools.png)

### Configuring Goose CLI

See [here](https://block.github.io/goose/docs/quickstart#install-an-extension) for detailed instructions on how to install the Goose CLI.

Once installed, follow these steps:

1. **Run the Configuration Command:**

   ```bash
   goose configure
   ```

2. **Follow the Interactive Prompts:**
   - Select `Add extension`
   - Choose `Command-line Extension`
   - Enter `mcp-confluent` as the extension name
   - Choose one of the following configuration methods:

   <details>
   <summary>Option 1: Run from source</summary>

   ```bash
   node /path/to/confluent-mcp-server/dist/index.js --env-file /path/to/confluent-mcp-server/.env
   ```

   </details>

   <details>
   <summary>Option 2: Run from npx</summary>

   ```bash
   npx -y @confluentinc/mcp-confluent -e /path/to/confluent-mcp-server/.env
   ```

   </details>

Replace `/path/to/confluent-mcp-server/` with the actual path where you've installed this MCP server.

![Goose Configure](assets/goose-configure.png)

### Configuring Gemini CLI

For detailed information about Gemini CLI extensions and MCP servers, please refer to the official documentation:

- [Gemini CLI Extensions](https://github.com/google-gemini/gemini-cli/blob/main/docs/extension.md)
- [Gemini CLI MCP Server Tools](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)

Here's how to get `mcp-confluent` running with Gemini CLI:

1. **Install Gemini CLI:**
    If you haven't already, install the Gemini CLI. You can find installation instructions on the [official GitHub repository](https://github.com/google-gemini/gemini-cli).

2. **Install the `mcp-confluent` Extension:**

    ```bash
    gemini extensions install https://github.com/confluentinc/mcp-confluent 
    # Navigate to the root directory of this project (where `gemini-extension.json` is located) and run:
    # gemini extensions install .
    ```

    This command registers the `mcp-confluent` server with Gemini CLI and creates a dedicated directory for it under `~/.gemini/extensions/mcp-confluent`.

3. **Provide Environment Variables:**
    The extension requires your Confluent Cloud credentials and configuration to be available in a `.env` file.

    - First, ensure you have a correctly populated `.env` file in the root of this project. For instructions, see the [Configuration](#configuration) section.
    - Next, copy your `.env` file into the extension's directory so Gemini CLI can access it (the Gemini extension expects the `.env` file at `${extensionPath}${pathSeparator}.env`; see [the variables documentation](https://github.com/google-gemini/gemini-cli/blob/main/docs/extension.md#variables) for details):

    ```bash
    cp .env ~/.gemini/extensions/mcp-confluent/.env
    ```

4. **Verify and Use:**
    You can now start using the Confluent tools via Gemini CLI. To verify that the tools are available, you can list them:

    ```bash
    gemini -l
    # or `gemini extensions list`
    ```

    And here's an example of invoking a tool:

    ```bash
    
    gemini
    ....

    🟢 mcp-confluent (from mcp-confluent) - Ready (24 tools)
    ....
    
    Using: 1 MCP server (ctrl+t to toggle)
    ╭───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
    │ > list topics                                                                                                                                             │
    ╰───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯

    ╭────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╮
    │ ✓  list-topics (mcp-confluent MCP Server) {}                                                                                                       │
    │                                                                                                                                                    │
    │    Kafka topics:                                                                                                                                   │
    │    products_summarized,products,topic_8,products_summarized_with_embeddings,elastic_minimized,user_message_related_products,user_message_embeddin  │
    │    gs,dlq-lcc-d3738o,user_message,elastic                                                                                          │
    ╰────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────╯
    ✦ Okay, I see the following topics: products_summarized, products, topic_8, products_summarized_with_embeddings, elastic_minimized,
      user_message_related_products, user_message_embeddings, dlq-lcc-d3738o, user_message, and elastic.

    ```

### mcp-confluent CLI Usage

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

<details>
<summary>Show output</summary>

```json
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-topics disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-topics disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-topics disabled due to allow/block list rules"}
{"level":"info","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool produce-message enabled"}
{"level":"info","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool consume-messages enabled"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-flink-statements disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-flink-statement disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool read-flink-statement disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-flink-statements disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-connectors disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool read-connector disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-connector disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-connector disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool search-topics-by-tag disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool search-topics-by-name disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-topic-tags disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-tag disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool remove-tag-from-entity disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool add-tags-to-topic disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-tags disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool alter-topic-config disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-clusters disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-environments disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool read-environment disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-schemas disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool get-topic-config disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":53394,"hostname":"YXR2D4NCM9","name":"mcp-confluent","msg":"Tool create-tableflow-topic disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":53394,"hostname":"YXR2D4NCM9","name":"mcp-confluent","msg":"Tool list-tableflow-regions disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":53394,"hostname":"YXR2D4NCM9","name":"mcp-confluent","msg":"Tool list-tableflow-topics disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":53394,"hostname":"YXR2D4NCM9","name":"mcp-confluent","msg":"Tool read-tableflow-topic disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":53394,"hostname":"YXR2D4NCM9","name":"mcp-confluent","msg":"Tool update-tableflow-topic disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":53394,"hostname":"YXR2D4NCM9","name":"mcp-confluent","msg":"Tool delete-tableflow-topic disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":53394,"hostname":"YXR2D4NCM9","name":"mcp-confluent","msg":"Tool create-tableflow-catalog-integration disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":53394,"hostname":"YXR2D4NCM9","name":"mcp-confluent","msg":"Tool list-tableflow-catalog-integrations disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":53394,"hostname":"YXR2D4NCM9","name":"mcp-confluent","msg":"Tool read-tableflow-catalog-integration disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":53394,"hostname":"YXR2D4NCM9","name":"mcp-confluent","msg":"Tool update-tableflow-catalog-integration disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:52:34.923Z","pid":53394,"hostname":"YXR2D4NCM9","name":"mcp-confluent","msg":"Tool delete-tableflow-catalog-integration disabled due to allow/block list rules"}
{"level":"info","time":"2025-05-14T16:52:34.924Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Starting transports: stdio on localhost:3000"}
{"level":"info","time":"2025-05-14T16:52:34.924Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"STDIO transport connected"}
{"level":"info","time":"2025-05-14T16:52:34.924Z","pid":46818,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"All transports started successfully"}
```

</details>

#### Example: Block Certain Tools

```bash
npx @confluentinc/mcp-confluent -e .env --block-tools produce-message,consume-messages
```

<details>
<summary>Show output</summary>

```json
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-topics enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-topics enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-topics enabled"}
{"level":"warn","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool produce-message disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool consume-messages disabled due to allow/block list rules"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-flink-statements enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-flink-statement enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool read-flink-statement enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-flink-statements enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-connectors enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool read-connector enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-connector enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-connector enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool search-topics-by-tag enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool search-topics-by-name enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-topic-tags enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-tag enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool remove-tag-from-entity enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool add-tags-to-topic enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-tags enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool alter-topic-config enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-clusters enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-environments enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool read-environment enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-schemas enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool get-topic-config enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-tableflow-topic enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-tableflow-regions enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-tableflow-topics enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool read-tableflow-topic enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool update-tableflow-topic enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-tableflow-topic enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-tableflow-catalog-integration enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-tableflow-catalog-integrations enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool read-tableflow-catalog-integration enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool update-tableflow-catalog-integration enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-tableflow-catalog-integration enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Starting transports: stdio"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"STDIO transport connected"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"All transports started successfully"}
```

</details>

#### Example: Use Tool Lists from Files

```bash
npx -y @confluentinc/mcp-confluent -e .env --allow-tools-file allow.txt --block-tools-file block.txt
```

<details>
<summary>Show output</summary>

```json
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-topics enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-topics enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-topics enabled"}
{"level":"warn","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool produce-message disabled due to allow/block list rules"}
{"level":"warn","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool consume-messages disabled due to allow/block list rules"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-flink-statements enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-flink-statement enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool read-flink-statement enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-flink-statements enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-connectors enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool read-connector enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-connector enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-connector enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool search-topics-by-tag enabled"}
{"level":"info","time":"2025-05-14T16:55:45.910Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool search-topics-by-name enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-topic-tags enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-tag enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool remove-tag-from-entity enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool add-tags-to-topic enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-tags enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool alter-topic-config enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-clusters enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-environments enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool read-environment enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-schemas enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool get-topic-config enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-tableflow-topic enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-tableflow-regions enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-tableflow-topics enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool read-tableflow-topic enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool update-tableflow-topic enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-tableflow-topic enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool create-tableflow-catalog-integration enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool list-tableflow-catalog-integrations enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool read-tableflow-catalog-integration enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool update-tableflow-catalog-integration enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Tool delete-tableflow-catalog-integration enabled"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"Starting transports: stdio"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"STDIO transport connected"}
{"level":"info","time":"2025-05-14T16:55:45.911Z","pid":47344,"hostname":"G9PW1FJH64","name":"mcp-confluent","msg":"All transports started successfully"}
```

</details>

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

## Developer Guide

### Project Structure

```sh
/
├── src/                 # Source code
│   ├── confluent/       # Confluent integration (API clients, etc.)
│   │   └── tools/           # Tool implementations
│   ├── mcp/             # MCP protocol and transport logic
│   │   └── transports/
│   └── ...              # Other server logic, utilities, etc.
├── dist/                # Compiled output
├── openapi.json         # OpenAPI specification for Confluent Cloud
├── .env                 # Environment variables (example - should be copied and filled)
├── README.md            # This file
└── package.json         # Node.js project metadata and dependencies
```

### Building and Running

1. **Install Dependencies:**

    ```bash
    npm install
    ```

2. **Development Mode (watch for changes):**

    ```bash
    npm run dev
    ```

    This command compiles the TypeScript code to JavaScript and automatically rebuilds when changes are detected in the `src/` directory.

3. **Production Build (one-time compilation):**

    ```bash
    npm run build
    ```

4. **Start the Server:**

    ```bash
    npm run start
    ```

### Docker

#### Prerequisites

Before you begin, ensure you have the following installed on your system:

Docker Desktop (or Docker Engine and Docker Compose): <https://www.docker.com/products/docker-desktop>

##### Environment Variables

The MCP server requires several environment variables to connect to Confluent Cloud and other relevant services. These should be provided in the `.env` file in the root directory of this project. Or you can add them directly in the `docker-compose.yml`

#### Building and Running with Docker

Here's how to build your Docker image and run it in different modes.

1. **Navigate to your project directory.** Open your terminal or command prompt and change to the directory containing the `Dockerfile`.

    ```bash
    cd /path/to/repo/mcp-confluent
    ```

2. **Build the Docker image.**

    This command creates the `mcp-server` image based on the `Dockerfile` in the current directory.

    ```bash
    docker build -t mcp-server .
    ```

3. **Run the container**

    - `--rm`: **Automatically removes the container** when it exits. This helps keep your system clean.
    - `-i`: Keeps **STDIN open** (runs the server using stdio transport by default).
    - `-d`: Runs the container in **detached mode** (in the background).
    - `-p 3000:3000`: **Maps port 3000** on your host machine to port 3000 inside the container. Adjust this if your app listens on a different port.

    ```bash
    docker run --rm -i -d -p 3000:3000 mcp-server
    ```

    (Optional)
    - `-t` **Transport Mode** to enable http transport

    ```bash
    docker run --rm -d -p 3000:3000 mcp-server -t http
    ```

#### Building and Running with Docker Compose

1. **Navigate to the project root:**
    Open your terminal or command prompt and change to the directory containing Dockerfile and docker-compose.yml.

    ```bash
    cd /path/to/repo/mcp-confluent
    ```

2. **Build and run the service:**
    Docker Compose will build the Docker image (if not already built) and start the mcp-server service.

    ```bash
    docker compose up --build
    ```

    The --build flag ensures that Docker Compose rebuilds the image before starting the container. You can omit this flag on subsequent runs if you haven't changed the Dockerfile or source code.

    The server will be accessible on <http://localhost:3000> (or the port specified in HTTP_PORT in your .env file).

3. **Stopping the Server**
    To stop the running MCP server and remove the containers, press Ctrl+C in the terminal where docker compose up is running.

    Alternatively, in a new terminal from the project root, you can run:

    ```bash
    docker compose down
    ```

    This command stops and removes the containers, networks, and volumes created by docker compose up.

### Testing

#### MCP Inspector

For testing MCP servers, you can use [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector) which is an interactive developer tool for testing and debugging MCP servers.

```bash
# make sure you've already built the project either in dev mode or by running npm run build
npx @modelcontextprotocol/inspector node  $PATH_TO_PROJECT/dist/index.js --env-file $PATH_TO_PROJECT/.env
```

### Adding a New Tool

1. Add a new enum to the enum class `ToolName`.
2. Add your new tool to the handlers map in the `ToolFactory` class.
3. Create a new file, exporting the class that extends `BaseToolHandler`.
    1. Implement the `handle` method of the base class.
    2. Implement the `getToolConfig` method of the base class.
4. Once satisfied, add it to the set of `enabledTools` in `index.ts`.

### Generating Types

```bash
# as of v7.5.2 there is a bug when using allOf w/ required https://github.com/openapi-ts/openapi-typescript/issues/1474. need --empty-objects-unknown flag to avoid it
npx openapi-typescript ./openapi.json -o ./src/confluent/openapi-schema.d.ts --empty-objects-unknown
```

### Contributing

Bug reports and feedback is appreciated in the form of Github Issues. For guidelines on contributing please see [CONTRIBUTING.md](CONTRIBUTING.MD)
