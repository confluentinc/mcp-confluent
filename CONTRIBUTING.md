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

Please use __Github Issues__ to report bugs. When filling out an issue report,
make sure to copy any related code and stack traces so we can properly debug.
We need to be able to reproduce a failing test to be able to fix your issue
most of the time, so a custom written failing test is very helpful.

### Suggesting Enhancements

Please use __Github Issues__ to suggest enhancements. We are happy to consider
any extra functionality or features to the library, as long as they add real
and related value to users. Describing your use case and why such an addition
helps the user base can help guide the decision to implement it into the
library's core.

### Pull Requests

* Include new test cases (either end-to-end or unit tests) with your change.
* Follow our style guides.
* Make sure all tests are still passing and the linter does not report any issues.
* End files with a new line.
* Make sure your branch is up to date and rebased.
* Squash extraneous commits unless their history truly adds value to the library.

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
│   │       ├── tool-factory.ts      # Tool registry
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
