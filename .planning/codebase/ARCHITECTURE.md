# Architecture

**Analysis Date:** 2026-03-11

## Pattern Overview

**Overall:** Tool-Handler MCP Server with Multi-Transport Layer

**Key Characteristics:**
- Model Context Protocol (MCP) server exposing Confluent Cloud REST APIs as discrete tools
- Stratified architecture with clear separation between transport, orchestration, and domain handlers
- Factory pattern for tool registration and lifecycle management
- Lazy initialization of expensive resources (Kafka clients, REST clients)
- Support for multiple concurrent transports (stdio, HTTP, SSE) with unified tool interface
- Environment-driven tool enablement/disablement based on credential availability

## Layers

**Transport Layer:**
- Purpose: Handle communication protocols between MCP clients and the server
- Location: `src/mcp/transports/`
- Contains: Protocol implementations (stdio, HTTP, SSE), authentication, server infrastructure
- Depends on: McpServer (MCP SDK), Fastify (for HTTP/SSE)
- Used by: Main entry point (`src/index.ts`)

**Orchestration Layer:**
- Purpose: Manage server lifecycle, tool registration, and request routing
- Location: `src/index.ts`, `src/cli.ts`
- Contains: CLI parsing, environment initialization, tool handler instantiation and registration
- Depends on: Transport Layer, Tool Factory, Client Manager
- Used by: Process entry point

**Tool Handler Layer:**
- Purpose: Implement business logic for each MCP tool
- Location: `src/confluent/tools/handlers/`
- Contains: Domain-specific handler implementations organized by service (kafka, flink, schema, connect, catalog, tableflow, etc.)
- Depends on: Client Manager, Schema definitions, Helper utilities
- Used by: Orchestration Layer via Tool Factory

**Client Management Layer:**
- Purpose: Centralize and manage all external service connections
- Location: `src/confluent/client-manager.ts`
- Contains: Lazy-initialized clients for Kafka, Confluent Cloud REST, Schema Registry, Kafka REST API
- Depends on: Kafka JavaScript client, OpenAPI clients, Schema Registry client
- Used by: Tool Handler Layer

**Configuration Layer:**
- Purpose: Load and validate environment variables and CLI arguments
- Location: `src/env.ts`, `src/env-schema.ts`, `src/cli.ts`
- Contains: Environment variable schema, validation, CLI argument parsing
- Depends on: dotenv, commander, zod (via MCP SDK)
- Used by: Orchestration Layer

**Utilities Layer:**
- Purpose: Provide shared helpers and middleware
- Location: `src/confluent/helpers.ts`, `src/confluent/middleware.ts`, `src/confluent/schema-registry-helper.ts`, `src/lazy.ts`, `src/logger.ts`
- Contains: Parameter validation, authentication middleware, lazy loading utilities, logging
- Used by: Tool handlers and client manager

## Data Flow

**Server Startup Flow:**

1. CLI parsing (`src/cli.ts`) - Extract command line arguments
2. Environment initialization (`src/env.ts`) - Load and validate .env variables
3. Client Manager setup (`src/confluent/client-manager.ts`) - Configure API clients (lazy)
4. Tool Factory registration (`src/confluent/tools/tool-factory.ts`) - Load all handler instances
5. Tool filtering - Enable/disable tools based on env vars and CLI flags
6. MCP Server creation - Register tools with McpServer instance
7. Transport Manager startup (`src/mcp/transports/manager.ts`) - Initialize and connect transports

**Request Handling Flow:**

1. Client sends tool call via transport (stdio/HTTP/SSE)
2. Transport layer receives request and forwards to McpServer
3. McpServer routes to appropriate tool handler
4. Tool handler:
   - Parses/validates arguments using Zod schema
   - Calls Client Manager to get service-specific client
   - Executes API call or business logic
   - Returns CallToolResult (text content + optional error flag)
5. Response travels back through transport to client

**State Management:**

- **Client Instances:** Lazily initialized and held by ClientManager. Per-service clients (Kafka, Flink, Schema Registry, Cloud REST)
- **Session State:** Session IDs passed through tool handler context allow tools to maintain consumer group isolation per session
- **Tool State:** Stateless - each request is independent
- **Configuration State:** Loaded at startup from environment, immutable during runtime

## Key Abstractions

**Tool Handler Interface:**
- Purpose: Define contract for all tool implementations
- Location: `src/confluent/tools/base-tools.ts`
- Pattern: Abstract base class with concrete implementations per tool
- Key methods:
  - `handle()` - Execute the tool's business logic
  - `getToolConfig()` - Provide MCP schema and description
  - `getRequiredEnvVars()` - Declare environment dependencies
  - `isConfluentCloudOnly()` - Flag for cloud-only tools
- Example: `src/confluent/tools/handlers/kafka/list-topics-handler.ts`

**Client Manager:**
- Purpose: Abstract away client creation and configuration complexity
- Location: `src/confluent/client-manager.ts`
- Pattern: Composition with lazy initialization for expensive resources
- Manages separate clients for:
  - Kafka (KafkaJS library)
  - Confluent Cloud REST APIs (OpenAPI clients)
  - Schema Registry (SchemaRegistryClient)
- Provides session-scoped consumer creation for tool isolation

**Tool Factory:**
- Purpose: Central registry for tool creation and discovery
- Location: `src/confluent/tools/tool-factory.ts`
- Pattern: Static factory with map of all handler instances
- Methods:
  - `createToolHandler()` - Get handler by ToolName
  - `getToolConfigs()` - Get all tool schemas
  - `getToolConfig()` - Get individual tool schema

**Transport Manager:**
- Purpose: Lifecycle management for multiple concurrent transports
- Location: `src/mcp/transports/manager.ts`
- Pattern: Manages creation, connection, and cleanup of Transport instances
- Supports: stdio, HTTP, SSE with unified interface

**Lazy and AsyncLazy:**
- Purpose: Defer expensive initialization until needed
- Location: `src/lazy.ts`
- Pattern: Generic wrappers for lazy value computation
- Used for: Kafka clients, REST clients, Schema Registry client

## Entry Points

**Main Entry Point:**
- Location: `src/index.ts`
- Triggers: `node dist/index.js [options]`
- Responsibilities:
  - Parse CLI arguments
  - Initialize environment
  - Create ClientManager with service credentials
  - Instantiate and register tool handlers
  - Create MCP server
  - Initialize and start transports
  - Handle process shutdown signals

**CLI Entry Point:**
- Location: `src/cli.ts`
- Special handlers:
  - `--generate-key` - Generate MCP API key before full initialization
  - `--list-tools` - List available tools and exit
  - `--env-file` - Load environment from custom file
  - `--transport` - Select which transports to enable
  - `--allow-tools` / `--block-tools` - Filter tools by name
  - `--disable-confluent-cloud-tools` - Disable cloud-only tools

**Tool Entry Points (examples):**
- `src/confluent/tools/handlers/kafka/list-topics-handler.ts` - List Kafka topics
- `src/confluent/tools/handlers/flink/create-flink-statement-handler.ts` - Create Flink SQL statement
- `src/confluent/tools/handlers/schema/list-schemas-handler.ts` - List Schema Registry schemas

## Error Handling

**Strategy:** Layered error handling with graceful degradation

**Patterns:**

- **Handler-Level:** Handlers catch errors and return `CallToolResult` with `isError: true` flag. Provides context-specific error messages to user.

- **Client Manager-Level:** Lazy initialization catches client creation errors. Connection failures logged but non-fatal (tools requiring that client become unavailable).

- **Transport-Level:** HTTP/SSE transports catch handler errors and return HTTP error responses with appropriate status codes. Stdio transport logs errors and continues.

- **Server-Level:** Unhandled errors in main() exit with status 1. Graceful shutdown on SIGINT/SIGTERM/SIGQUIT/SIGUSR2.

- **Validation-Level:** Zod schemas validate tool arguments. Invalid arguments return error response without handler execution.

Example error response from handler:
```typescript
return this.createResponse("Failed to list topics: Connection timeout", true);
```

## Cross-Cutting Concerns

**Logging:**
- Framework: Pino (structured JSON logging)
- Configuration: `src/logger.ts`
- Log level set from env var `LOG_LEVEL` (default: info)
- Per-service loggers for Kafka (`kafkaLogger`)
- All transports and client creation log lifecycle events

**Validation:**
- Framework: Zod (schema validation)
- Usage: Every tool handler defines input schema via Zod
- Automatic validation before handler execution
- Environment variable schema validation at startup

**Authentication:**
- Kafka: SASL_PLAIN with API key/secret
- Confluent Cloud REST: Bearer token computed from API key/secret
- HTTP/SSE MCP: Optional API key authentication controlled by MCP_API_KEY env var
- Middleware: `src/confluent/middleware.ts` provides auth header creation for REST calls

**Type Safety:**
- OpenAPI schema generation via `openapi-typescript` from `openapi.json`
- Generated types at `src/confluent/openapi-schema.d.ts`
- TypeScript strict mode enabled (with noImplicitAny disabled for specific type resolution issues - see tsconfig.json comment)
- Full source maps for debugging

---

*Architecture analysis: 2026-03-11*
