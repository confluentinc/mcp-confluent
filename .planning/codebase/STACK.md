# Technology Stack

**Analysis Date:** 2026-03-11

## Languages

**Primary:**
- TypeScript 5.8.3 - Full application source code, strict mode enabled
- JavaScript (ESNext) - Compiled target for runtime execution

**Secondary:**
- Shell - Docker and build scripting
- JSON - Configuration and OpenAPI schema

## Runtime

**Environment:**
- Node.js >= 22 (required by dependencies)

**Package Manager:**
- npm (latest) - Dependency management
- Lockfile: `package-lock.json` (present and committed)

## Frameworks

**Core:**
- `@modelcontextprotocol/sdk` 1.23.1 - MCP (Model Context Protocol) server implementation and tool registry
- `fastify` 5.4.0 - HTTP/SSE web server framework for transport layer

**Message Queue:**
- `@confluentinc/kafka-javascript` 1.3.2 - Confluent's Kafka client for Node.js with SASL/SSL support

**Schema Management:**
- `@confluentinc/schemaregistry` 1.3.1 - Schema Registry client for schema validation and versioning

**API Clients:**
- `openapi-fetch` 0.14.0 - Type-safe OpenAPI client generation from OpenAPI schema
- `openapi-typescript` 7.8.0 (dev) - OpenAPI schema to TypeScript type generation

**HTTP/REST Support:**
- `@fastify/swagger` 9.5.1 - API documentation and schema serving
- `@fastify/swagger-ui` 5.2.3 - Interactive API documentation UI

**CLI & Configuration:**
- `commander` 14.0.0 - Command-line argument parsing and help text
- `@commander-js/extra-typings` 14.0.0 - TypeScript type definitions for commander
- `dotenv` 16.5.0 - Environment variable loading from `.env` files

**Logging:**
- `pino` 10.1.0 - High-performance JSON logging

**Utilities:**
- `properties-file` 3.5.12 - Kafka properties file parsing
- `zod` 4.0 - Schema validation (overridden, used by MCP SDK)

## Build & Development Tools

**Compilation:**
- `typescript` 5.8.3 - TypeScript compiler
- `tsc-alias` 1.8.16 - Path alias resolution post-compilation (required for `@src/*` paths)

**Development Workflow:**
- `concurrently` 9.2.0 - Parallel command execution (tsc watch + tsc-alias watch)

**Code Quality:**
- `eslint` 9.29.0 - Linting and code standards
- `@typescript-eslint/eslint-plugin` 8.35.0 - TypeScript-specific linting rules
- `@typescript-eslint/parser` 8.35.0 - TypeScript parser for ESLint
- `prettier` 3.6.1 - Code formatting
- `eslint-config-prettier` 10.1.5 - ESLint prettier integration
- `eslint-plugin-prettier` 5.5.1 - Prettier as ESLint rule

**Pre-commit Hooks:**
- `husky` 9.1.7 - Git hook management

**Type Utilities:**
- `@types/node` 24.0.4 - Node.js type definitions
- `@types/ws` 8.18.1 - WebSocket type definitions
- `@types/content-type` 1.1.9 - Content-Type parsing type definitions

## Configuration

**Environment:**
- Configuration via environment variables (see `src/env-schema.ts`)
- `.env.example` provides template with all available variables
- Variables are loaded with `dotenv` when `--env-file .env` flag is used
- Variables can be passed directly or read from file

**Build:**
- `tsconfig.json` - TypeScript compilation configuration
  - Target: ESNext
  - Module system: NodeNext (ES modules)
  - Path aliases: `@src/*` → `src/*`
  - Strict type checking enabled
  - Output directory: `./dist`

**Linting:**
- `eslint.config.mjs` - ESLint configuration (flat config format)

**Code Formatting:**
- `.prettierignore` - Prettier ignore rules

## Deployment

**Docker:**
- Multi-stage Dockerfile (builder + production)
- Base image: `node:22-alpine` (official Node.js Alpine Linux)
- Runs compiled application: `node dist/index.js`
- Supports command-line transport selection: `--transport http` (default), `--transport sse`, `--transport stdio`

**Docker Compose:**
- `docker-compose.yml` - Local development with .env integration
- Service: `mcp-server`
- Port mapping: `${HTTP_PORT:-3000}:${HTTP_PORT:-3000}`
- Environment file: `.env`

## Platform Requirements

**Development:**
- Node.js >= 22
- npm (latest recommended)
- TypeScript knowledge (strict mode enabled)

**Production:**
- Node.js >= 22
- Confluent Cloud account and credentials
- Network access to Confluent Cloud REST APIs and Kafka brokers

## Transport Mechanisms

The MCP server supports three transport mechanisms:

**1. Standard I/O (stdio):**
- Default for Claude Desktop integration
- Reads from stdin, writes to stdout
- Synchronous message-based protocol

**2. HTTP (REST):**
- Requires `fastify` HTTP server
- Configured port (default: 8080)
- Path: `/mcp` (configurable)
- Authentication via Bearer token or disabled in dev

**3. Server-Sent Events (SSE):**
- Streaming protocol via HTTP
- Connection endpoint: `/sse` (configurable)
- Message endpoint: `/messages` (configurable)
- Used for long-lived connections

All transports are managed by `TransportManager` in `src/mcp/transports/manager.ts`.

## Key Dependencies Matrix

| Package | Version | Purpose | Critical |
|---------|---------|---------|----------|
| @modelcontextprotocol/sdk | 1.23.1 | MCP protocol | ✓ |
| @confluentinc/kafka-javascript | 1.3.2 | Kafka operations | ✓ |
| fastify | 5.4.0 | HTTP/SSE server | ✓ |
| @confluentinc/schemaregistry | 1.3.1 | Schema operations | ✓ |
| openapi-fetch | 0.14.0 | REST client | ✓ |
| commander | 14.0.0 | CLI argument parsing | ✓ |
| dotenv | 16.5.0 | Environment config | ✓ |
| pino | 10.1.0 | Logging | Required |
| properties-file | 3.5.12 | Kafka properties | Optional |

---

*Stack analysis: 2026-03-11*
