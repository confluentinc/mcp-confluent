# Contributing to `confluent-kafka-javascript`

:+1::tada: First off, thanks for taking the time to contribute! :tada::+1:

The following is a set of guidelines for contributing to `mcp-confluent`
which is hosted by [Confluent Inc.](https://github.com/confluentinc)
on GitHub. This document lists rules, guidelines, and help getting started,
so if you feel something is missing feel free to send a pull request.

## What should I know before I get started?

### Contributor Agreement

Required (please follow instructions after making any Pull Requests).

## How can I contribute?

### Reporting Bugs

Please use **Github Issues** to report bugs. When filling out an issue report,
make sure to copy any related code and stack traces so we can properly debug.
We need to be able to reproduce a failing test to be able to fix your issue
most of the time, so a custom written failing test is very helpful.

### Suggesting Enhancements

Please use **Github Issues** to suggest enhancements. We are happy to consider
any extra functionality or features to the library, as long as they add real
and related value to users. Describing your use case and why such an addition
helps the user base can help guide the decision to implement it into the
library's core.

### Pull Requests

- Include new test cases (either end-to-end or unit tests) with your change.
- Follow our style guides.
- Make sure all tests are still passing and the linter does not report any issues.
- End files with a new line.
- Make sure your branch is up to date and rebased.
- Squash extraneous commits unless their history truly adds value to the library.

## Developer Guide

### Project Structure

```sh
/
├── src/                    # Source code
│   ├── index.ts                # Main entry point
│   ├── cli.ts                  # CLI argument parsing
│   ├── env.ts                  # Environment initialization
│   ├── env-schema.ts           # Environment variable schema (Zod)
│   ├── logger.ts               # Logger configuration
│   ├── confluent/              # Confluent integration
│   │   ├── client-manager.ts       # API client management
│   │   ├── schema-registry-helper.ts
│   │   └── tools/
│   │       ├── base-tools.ts        # Base handler class
│   │       ├── tool-registry.ts     # Tool registry
│   │       ├── tool-name.ts         # Tool name enum
│   │       └── handlers/
│   │           ├── billing/         # Billing tools
│   │           ├── catalog/         # Catalog & tag tools
│   │           ├── clusters/        # Cluster tools
│   │           ├── connect/         # Connector tools
│   │           ├── environments/    # Environment tools
│   │           ├── flink/           # Flink SQL, catalog & diagnostics tools
│   │           ├── kafka/           # Kafka topic & message tools
│   │           ├── metrics/         # Telemetry API metrics tools
│   │           ├── schema/          # Schema Registry tools
│   │           ├── search/          # Search tools
│   │           └── tableflow/       # Tableflow topic & catalog tools
│   └── mcp/                    # MCP protocol and transport logic
│       └── transports/
│           ├── http.ts              # HTTP transport
│           ├── sse.ts               # SSE transport
│           ├── stdio.ts             # STDIO transport
│           ├── auth.ts              # Authentication middleware
│           └── manager.ts           # Transport manager
├── dist/                   # Compiled output
├── openapi.json            # OpenAPI specification for Confluent Cloud
├── .env.example            # Example environment variables
├── README.md               # This file
└── package.json            # Node.js project metadata and dependencies
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
   - `-p 8080:8080`: **Maps port 8080** on your host machine to port 8080 inside the container. The default HTTP_PORT is 8080; adjust if you've configured a different port.

   ```bash
   docker run --rm -i -d -p 8080:8080 mcp-server
   ```

   (Optional)
   - `-t` **Transport Mode** to enable http transport

   ```bash
   docker run --rm -d -p 8080:8080 mcp-server -t http
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

   The server will be accessible on <http://localhost:8080> (or the port specified in HTTP_PORT in your .env file).

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

### Local Development with an MCP Client

While the [MCP Inspector](#mcp-inspector) is useful for ad-hoc tool testing, this setup lets you develop against a real MCP client (Claude Code, Cursor, etc.) with full server log visibility. By default, MCP clients spawn the server as a child process using stdio transport, which makes server logs difficult to observe. Running the server in HTTP mode gives you direct access to logs while the client interacts with it normally.

After building the project (see [Building and Running](#building-and-running)):

#### 1. Start the server in HTTP mode

```bash
npm run start:http -- --disable-auth
```

> [!WARNING]
> Never disable authentication in production or when the server is network-accessible.

This starts the server on `http://127.0.0.1:8080/mcp` (the defaults for `HTTP_HOST`, `HTTP_PORT`, and `HTTP_MCP_ENDPOINT_PATH`) with authentication disabled for local development.

#### 2. Point your MCP client at the running server

Instead of the default stdio configuration, configure your assistant's MCP settings to connect via HTTP. For example, in `.mcp.json`:

```json
{
  "mcpServers": {
    "confluent-dev": {
      "type": "http",
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```

This replaces the typical `command`/`args` config that spawns a stdio child process.

> [!IMPORTANT]
> After restarting the MCP server, you may also need to restart or reconnect your MCP client so it picks up the new server process. For example, in Claude Code use the `/mcp` command to reconnect.

#### 3. Observe server logs

All server logs are written to stderr via pino and will appear directly in the terminal where you started the server. Set `LOG_LEVEL=debug` for more verbose output. To capture logs to a file instead:

```bash
npm run start:http -- --disable-auth 2>server.log
```

Then tail in a separate terminal:

```bash
tail -f server.log
```

### IDE Configuration for Development

The repository includes checked-in configs for debugging the MCP server and connecting MCP clients (Claude Code, GitHub Copilot) to a local dev instance.

**Prerequisites:** `npm install`, a `.env` file populated from `.env.example`.

#### Starting the Dev Server

Press **F5** in VS Code to build and start the server in HTTP mode with auth disabled. The launch config (`.vscode/launch.json`) automatically runs `npm run build`, enables pretty logging (`LOG_PRETTY=true`, `LOG_LEVEL=debug`), and attaches the debugger. The server starts on `http://127.0.0.1:18080/mcp` (port 18080 is used to avoid conflicts with the default 8080).

#### Connecting MCP Clients

Two project-level MCP configs register a `confluent-dev` server (distinct from the published `confluent` package that end users configure). Both connect to the locally running HTTP server started by F5:

| File               | Client         |
| ------------------ | -------------- |
| `.mcp.json`        | Claude Code    |
| `.vscode/mcp.json` | GitHub Copilot |

After pressing F5, your MCP client should automatically discover the `confluent-dev` server. If you change `.env` or source code, restart the debug session (Ctrl+Shift+F5 or stop + F5) and reconnect the MCP client:

- **Claude Code:** Restart the session or use `/mcp` to reconnect. Tool changes are picked up automatically.
- **GitHub Copilot:** Open `.vscode/mcp.json` and click **Start** or **Restart** in the code lens above `confluent-dev` to reconnect Copilot to the server. The code lens shows **Running** once Copilot is connected and has fetched the current tool list. (Copilot does not automatically detect when an HTTP server restarts.)

### Adding a New Tool

Tools are auto-enabled at startup based on which environment variables are present: each handler declares its requirements via `getRequiredEnvVars()`, and the server only exposes handlers whose requirements are satisfied. There is no manual enabled-tools list to maintain.

1. Add a new entry to the `ToolName` enum in `src/confluent/tools/tool-name.ts`.
2. Create a handler class under `src/confluent/tools/handlers/<domain>/` (pick the existing domain directory that matches the Confluent service the tool wraps, or add a new one). The class must extend `BaseToolHandler`.
3. On your handler, implement:
   - `getToolConfig()` — returns the tool name, description, Zod input schema, and annotations (`READ_ONLY`, `CREATE_UPDATE`, `DESTRUCTIVE`). For tools with no parameters, pass `inputSchema: {}`, not an omitted field.
   - `handle()` — the runtime implementation.
   - `getRequiredEnvVars()` — the env vars that must be set for the server to expose this tool.
4. Register the handler in the `ToolHandlerRegistry.handlers` map in `src/confluent/tools/tool-registry.ts`.
5. If the tool calls a Confluent Cloud REST endpoint whose path or response shape isn't already in `openapi.json`, add it and regenerate the typed client — see [Generating Types](#generating-types) below.

### Generating Types

`openapi.json` is a vendored snapshot of the public Confluent Cloud API spec. It drives the typed `openapi-fetch` clients in `src/confluent/client-manager.ts`, and only needs changes when a new handler calls a Confluent Cloud REST endpoint whose path or response shape isn't already described there (for example, a preview API the snapshot predates). Handlers that wrap existing typed endpoints, or that go through the Kafka / Schema Registry SDKs, don't require a spec edit.

If you edit `openapi.json`, regenerate `src/confluent/openapi-schema.d.ts`:

```bash
npm run generate:openapi-types
```

Commit both files together so downstream contributors see the same types the vendored spec describes.

> The script passes `--empty-objects-unknown` to work around [openapi-typescript#1474](https://github.com/openapi-ts/openapi-typescript/issues/1474) (a bug since v7.5.2 with `allOf` + `required`).
