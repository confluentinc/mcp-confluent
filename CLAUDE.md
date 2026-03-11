# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server that exposes Confluent Cloud REST APIs to AI assistants like Claude Desktop and Goose CLI. It enables natural language interactions with Kafka topics, Flink SQL statements, connectors, schemas, and other Confluent Cloud resources.

## Development Commands

### Building and Running

```bash
# Build the project (TypeScript compilation + path alias resolution)
npm run build

# Watch mode for development
npm run dev

# Type checking without emitting files
npm run test:ts

# Run with different transports
npm start                    # stdio transport (default for Claude Desktop)
npm start:http               # HTTP transport
npm start:sse                # SSE transport
npm start:all                # All transports simultaneously

# Debug with MCP Inspector
npm run inspector
```

### Code Quality

```bash
# Lint code
npm run lint

# Auto-fix linting issues
npm run lint:fix

# Format code with Prettier
npm run format
```

### Utilities

```bash
# Generate API key for HTTP/SSE auth
npx @confluentinc/mcp-confluent --generate-key

# Print tool schema documentation
npm run print:schema

# List available tools
node dist/index.js --list-tools
```

## Architecture

### Tool-Based Architecture

The server uses a **tool-handler pattern** where each Confluent Cloud capability is exposed as an MCP tool:

- **Tool Factory** (`src/confluent/tools/tool-factory.ts`): Central registry that maps tool names to handler instances
- **Base Tool Handler** (`src/confluent/tools/base-tools.ts`): Abstract base class defining the handler interface
- **Tool Handlers** (`src/confluent/tools/handlers/`): Implementations organized by domain

### Handler Organization

Handlers are grouped by Confluent Cloud service domain:

```
src/confluent/tools/handlers/
├── kafka/              # Kafka operations (topics, produce, consume, config)
├── flink/              # Flink SQL statements and catalog operations
│   ├── catalog/        # Catalog metadata (databases, tables, schemas)
│   └── diagnostics/    # Statement health checks and profiling
├── schema/             # Schema Registry operations
├── connect/            # Kafka Connect connector management
├── catalog/            # Data Catalog tagging operations
├── tableflow/          # Tableflow (preview) topic and catalog integrations
├── search/             # Topic search by name or tags
├── environments/       # Environment and cluster management
├── clusters/           # Cluster operations
└── billing/            # Billing cost queries
```

### Transport Layer

MCP server supports three transport mechanisms (`src/mcp/transports/`):

- **stdio**: Default for Claude Desktop integration (stdin/stdout)
- **HTTP**: REST API with authentication
- **SSE**: Server-Sent Events for streaming

All transports are managed by `TransportManager` and share the same tool registry.

### Client Management

`ClientManager` (`src/confluent/client-manager.ts`) centralizes API client instantiation and configuration:

- Manages separate clients for Confluent Cloud, Flink, Schema Registry, Kafka REST, and Tableflow
- Handles authentication credentials per service
- Uses lazy initialization to only create clients when needed
- Supports session-based client isolation (e.g., separate consumer groups per session)

### Path Aliases

The codebase uses TypeScript path aliases for cleaner imports:

- `@src/*` maps to `src/*`
- Compilation requires both `tsc` and `tsc-alias` (run via `npm run build`)

### Environment Configuration

The server is highly configurable via environment variables (see `.env.example`). Required variables depend on which tools are enabled:

- **Kafka tools**: `BOOTSTRAP_SERVERS`, `KAFKA_API_KEY`, `KAFKA_API_SECRET`
- **Flink tools**: `FLINK_REST_ENDPOINT`, `FLINK_API_KEY`, `FLINK_API_SECRET`, `FLINK_COMPUTE_POOL_ID`
- **Schema Registry tools**: `SCHEMA_REGISTRY_ENDPOINT`, `SCHEMA_REGISTRY_API_KEY`, `SCHEMA_REGISTRY_API_SECRET`
- **Cloud management tools**: `CONFLUENT_CLOUD_API_KEY`, `CONFLUENT_CLOUD_API_SECRET`

Tools are automatically disabled if their required environment variables are not set.

### Tool Filtering

The CLI supports selective tool enabling/disabling:

```bash
# Allow only specific tools
node dist/index.js --allow-tools "list_topics,create_topics"

# Block specific tools
node dist/index.js --block-tools "delete_topics,delete_flink_statements"

# Disable all Confluent Cloud management tools
node dist/index.js --disable-confluent-cloud-tools
```

## Adding New Tools

To add a new MCP tool:

1. **Create handler**: Add new handler class in `src/confluent/tools/handlers/<domain>/`
   - Extend `BaseToolHandler`
   - Implement `handle()`, `getToolConfig()`, and optionally `getRequiredEnvVars()` and `isConfluentCloudOnly()`

2. **Register tool name**: Add enum entry to `ToolName` in `src/confluent/tools/tool-name.ts`

3. **Register in factory**: Add handler instance to `ToolFactory.handlers` map in `src/confluent/tools/tool-factory.ts`

4. **Add OpenAPI types** (if using Confluent Cloud REST API): Update `openapi.json` and regenerate types with `openapi-typescript`

## Key Dependencies

- `@modelcontextprotocol/sdk`: MCP protocol implementation
- `@confluentinc/kafka-javascript`: Confluent's Kafka client for Node.js
- `@confluentinc/schemaregistry`: Schema Registry client
- `openapi-fetch`: Type-safe OpenAPI client generation
- `fastify`: HTTP/SSE server framework
- `commander`: CLI argument parsing
- `zod`: Schema validation (via MCP SDK)

## Testing

Currently, there are no automated tests in this repository. Type checking is performed via `npm run test:ts`.

## Node Version Requirement

This project requires **Node.js >= 22** due to dependency requirements.
