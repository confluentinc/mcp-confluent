# mcp-confluent

An MCP server implementation that enables AI assistants to interact with Confluent Cloud REST APIs. This server allows AI tools like Claude Desktop and Goose CLI to manage Kafka topics, connectors, and Flink SQL statements through natural language interactions.

<a href="https://glama.ai/mcp/servers/@confluentinc/mcp-confluent">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@confluentinc/mcp-confluent/badge" alt="mcp-confluent MCP server" />
</a>

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
    - [Environment Variables Reference](#environment-variables-reference)
    - [Usage](#usage)
    - [Configuring Claude Desktop](#configuring-claude-desktop)
    - [Configuring Goose CLI](#configuring-goose-cli)
  - [Developer Guide](#developer-guide)
    - [Project Structure](#project-structure)
    - [Building and Running](#building-and-running)
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
CONFLUENT_CLOUD_API_KEY=""
CONFLUENT_CLOUD_API_SECRET=""
CONFLUENT_CLOUD_REST_ENDPOINT="https://api.confluent.cloud"
SCHEMA_REGISTRY_API_KEY="..."
SCHEMA_REGISTRY_API_SECRET="..."
SCHEMA_REGISTRY_ENDPOINT="https://psrc-zv01y.northamerica-northeast2.gcp.confluent.cloud"
```
</details>

### Environment Variables Reference

| Variable                      | Description                                                                                                                               | Default Value | Required |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------- | -------- |
| BOOTSTRAP_SERVERS             | List of Kafka broker addresses in the format host1:port1,host2:port2 used to establish initial connection to the Kafka cluster (string)   |               | Yes      |
| CONFIG_PATH                   | File system path to store and retrieve conversation-based configurations for session persistence (Future Implementation) (string)         |               | Yes      |
| CONFLUENT_CLOUD_API_KEY       | Master API key for Confluent Cloud platform administration, enabling management of resources across your organization (string (min: 1))   |               | Yes      |
| CONFLUENT_CLOUD_API_SECRET    | Master API secret paired with CONFLUENT_CLOUD_API_KEY for comprehensive Confluent Cloud platform administration (string (min: 1))         |               | Yes      |
| FLINK_API_KEY                 | Authentication key for accessing Confluent Cloud's Flink services, including compute pools and SQL statement management (string (min: 1)) |               | Yes      |
| FLINK_API_SECRET              | Secret token paired with FLINK_API_KEY for authenticated access to Confluent Cloud's Flink services (string (min: 1))                     |               | Yes      |
| KAFKA_API_KEY                 | Authentication credential (username) required to establish secure connection with the Kafka cluster (string (min: 1))                     |               | Yes      |
| KAFKA_API_SECRET              | Authentication credential (password) paired with KAFKA_API_KEY for secure Kafka cluster access (string (min: 1))                          |               | Yes      |
| SCHEMA_REGISTRY_API_KEY       | Authentication key for accessing Schema Registry services to manage and validate data schemas (string (min: 1))                           |               | Yes      |
| SCHEMA_REGISTRY_API_SECRET    | Authentication secret paired with SCHEMA_REGISTRY_API_KEY for secure Schema Registry access (string (min: 1))                             |               | Yes      |
| CONFLUENT_CLOUD_REST_ENDPOINT | Base URL for Confluent Cloud's REST API services (default)                                                                                |               | No       |
| FLINK_COMPUTE_POOL_ID         | Unique identifier for the Flink compute pool, must start with 'lfcp-' prefix (string)                                                     |               | No       |
| FLINK_DATABASE_NAME           | Name of the associated Kafka cluster used as a database reference in Flink SQL operations (string (min: 1))                               |               | No       |
| FLINK_ENV_ID                  | Unique identifier for the Flink environment, must start with 'env-' prefix (string)                                                       |               | No       |
| FLINK_ENV_NAME                | Human-readable name for the Flink environment used for identification and display purposes (string (min: 1))                              |               | No       |
| FLINK_ORG_ID                  | Organization identifier within Confluent Cloud for Flink resource management (string (min: 1))                                            |               | No       |
| FLINK_REST_ENDPOINT           | Base URL for Confluent Cloud's Flink REST API endpoints used for SQL statement and compute pool management (string)                       |               | No       |
| KAFKA_CLUSTER_ID              | Unique identifier for the Kafka cluster within Confluent Cloud ecosystem (string (min: 1))                                                |               | No       |
| KAFKA_ENV_ID                  | Environment identifier for Kafka cluster, must start with 'env-' prefix (string)                                                          |               | No       |
| KAFKA_REST_ENDPOINT           | REST API endpoint for Kafka cluster management and administration (string)                                                                |               | No       |
| SCHEMA_REGISTRY_ENDPOINT      | URL endpoint for accessing Schema Registry services to manage data schemas (string)                                                       |               | No       |

### Usage

This MCP server is designed to be used with various MCP clients, such as Claude Desktop or Goose CLI/Desktop.  The specific configuration and interaction will depend on the client you are using.  However, the general steps are:

1. **Build:** Follow the instructions in the [Developer Guide](#developer-guide) to build and run the server from source. This typically involves:
    - Installing dependencies (`npm install`)
    - Building the project (`npm run build` or `npm run dev`)

2. **Configure your MCP Client:**  Each client will have its own way of specifying the MCP server's address and any required credentials.  You'll need to configure your client (e.g., Claude, Goose) to connect to the address where this server is running (likely `localhost` with a specific port). The port the server runs on may be configured by an environment variable.

3. **Start the MCP Client:**  Once your client is configured to connect to the MCP server, you can start your mcp client and on startup - it will stand up an instance of this MCP server locally.  This instance will be responsible for managing data schemas and interacting with Confluent Cloud on your behalf.

4. **Interact with Confluent through the Client:** Once the client is connected, you can use the client's interface to interact with Confluent Cloud resources.  The client will send requests to this MCP server, which will then interact with Confluent Cloud on your behalf.

### Configuring Claude Desktop

See [here](https://modelcontextprotocol.io/quickstart/user) for more details about installing Claude Desktop and MCP servers.

To configure Claude Desktop to use this MCP server:

1. **Open Claude Desktop Configuration**
   - On Mac: `~/Library/Application Support/Claude/claude_desktop_config.json`
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
           "/path/to/confluent-mcp-server/.env",
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

## Developer Guide

### Project Structure

```sh
/
├── src/                 # Source code
│   ├── confluent/       # Code related to Confluent integration (API clients, etc.)
│   ├── tools/           # Tool implementations (each tool in a separate file)
│   ├── index.ts         # Main entry point for the server
│   └── ...              # Other server logic, utilities, etc.
├── dist/                # Compiled output (TypeScript -> JavaScript)
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