# Codebase Structure

**Analysis Date:** 2026-03-11

## Directory Layout

```
mcp-confluent/
├── src/
│   ├── index.ts                          # Server entry point
│   ├── cli.ts                            # CLI argument parsing
│   ├── env.ts                            # Environment initialization
│   ├── env-schema.ts                     # Environment variable schema
│   ├── logger.ts                         # Logging configuration
│   ├── lazy.ts                           # Lazy initialization utilities
│   ├── print-md-schema.ts                # Tool schema markdown printer
│   │
│   ├── confluent/
│   │   ├── client-manager.ts             # Centralized API client management
│   │   ├── middleware.ts                 # Auth middleware for API calls
│   │   ├── helpers.ts                    # Shared utility functions
│   │   ├── schema.ts                     # Type definitions (CallToolResult)
│   │   ├── schema-registry-helper.ts     # Schema Registry utilities
│   │   ├── openapi-schema.d.ts           # Generated OpenAPI types
│   │   │
│   │   └── tools/
│   │       ├── tool-factory.ts           # Tool registry and factory
│   │       ├── tool-name.ts              # ToolName enum
│   │       ├── base-tools.ts             # Base handler interface/class
│   │       │
│   │       └── handlers/
│   │           ├── kafka/                # Kafka topic operations
│   │           │   ├── list-topics-handler.ts
│   │           │   ├── create-topics-handler.ts
│   │           │   ├── delete-topics-handler.ts
│   │           │   ├── produce-kafka-message-handler.ts
│   │           │   ├── consume-kafka-messages-handler.ts
│   │           │   ├── alter-topic-config.ts
│   │           │   └── get-topic-config.ts
│   │           │
│   │           ├── flink/                # Flink SQL operations
│   │           │   ├── create-flink-statement-handler.ts
│   │           │   ├── delete-flink-statement-handler.ts
│   │           │   ├── read-flink-statement-handler.ts
│   │           │   ├── list-flink-statements-handler.ts
│   │           │   ├── get-flink-exceptions-handler.ts
│   │           │   ├── flink-sql-helper.ts
│   │           │   │
│   │           │   ├── catalog/          # Flink catalog metadata
│   │           │   │   ├── list-catalogs-handler.ts
│   │           │   │   ├── list-databases-handler.ts
│   │           │   │   ├── list-tables-handler.ts
│   │           │   │   ├── describe-table-handler.ts
│   │           │   │   ├── get-table-info-handler.ts
│   │           │   │   └── catalog-resolver.ts
│   │           │   │
│   │           │   └── diagnostics/      # Flink health and profiling
│   │           │       ├── check-health-handler.ts
│   │           │       ├── detect-issues-handler.ts
│   │           │       ├── query-profiler-handler.ts
│   │           │       └── metrics-helper.ts
│   │           │
│   │           ├── schema/               # Schema Registry operations
│   │           │   ├── list-schemas-handler.ts
│   │           │   └── delete-schema-handler.ts
│   │           │
│   │           ├── connect/              # Kafka Connect management
│   │           │   ├── list-connectors-handler.ts
│   │           │   ├── read-connectors-handler.ts
│   │           │   ├── create-connector-handler.ts
│   │           │   └── delete-connector-handler.ts
│   │           │
│   │           ├── catalog/              # Data Catalog tagging
│   │           │   ├── list-tags.ts
│   │           │   ├── create-topic-tags.ts
│   │           │   ├── add-tags-to-topic.ts
│   │           │   ├── remove-tag-from-entity.ts
│   │           │   └── delete-tag.ts
│   │           │
│   │           ├── tableflow/            # Tableflow (preview) integrations
│   │           │   ├── list-tableflow-regions-handler.ts
│   │           │   │
│   │           │   ├── topic/            # Tableflow topic operations
│   │           │   │   ├── create-tableflow-topic-handler.ts
│   │           │   │   ├── read-tableflow-topic-handler.ts
│   │           │   │   ├── list-tableflow-topics-handler.ts
│   │           │   │   ├── update-tableflow-topic-handler.ts
│   │           │   │   └── delete-tableflow-topic-handler.ts
│   │           │   │
│   │           │   └── catalog/         # Tableflow catalog integrations
│   │           │       ├── create-tableflow-catalog-integration-handler.ts
│   │           │       ├── read-tableflow-catalog-integration-handler.ts
│   │           │       ├── list-tableflow-catalog-integrations-handler.ts
│   │           │       ├── update-tableflow-catalog-integration-handler.ts
│   │           │       └── delete-tableflow-catalog-integration-handler.ts
│   │           │
│   │           ├── search/               # Topic search operations
│   │           │   ├── search-topics-by-name-handler.ts
│   │           │   └── search-topic-by-tag-handler.ts
│   │           │
│   │           ├── environments/         # Environment management
│   │           │   ├── list-environments-handler.ts
│   │           │   └── read-environment-handler.ts
│   │           │
│   │           ├── clusters/             # Cluster operations
│   │           │   └── list-clusters-handler.ts
│   │           │
│   │           └── billing/              # Billing queries
│   │               └── list-billing-costs-handler.ts
│   │
│   └── mcp/
│       └── transports/
│           ├── types.ts                  # Transport type definitions
│           ├── index.ts                  # Transport exports and API key generation
│           ├── manager.ts                # Transport lifecycle manager
│           ├── auth.ts                   # HTTP auth configuration
│           ├── server.ts                 # Fastify HTTP server
│           ├── stdio.ts                  # Stdio transport implementation
│           ├── http.ts                   # HTTP transport implementation
│           ├── sse.ts                    # Server-Sent Events transport
│           └── ping.ts                   # Ping handler for health checks
│
├── .planning/
│   └── codebase/                         # GSD analysis documents
│
├── assets/                               # Static assets
├── .github/                              # GitHub workflows
├── .semaphore/                           # Semaphore CI/CD
├── .husky/                               # Git hooks
├── package.json                          # Dependencies and scripts
├── tsconfig.json                         # TypeScript configuration
├── eslint.config.mjs                     # ESLint configuration
├── Dockerfile                            # Container build
├── docker-compose.yml                    # Docker Compose setup
├── openapi.json                          # Confluent Cloud OpenAPI spec
├── .env.example                          # Example environment variables
├── README.md                             # Project documentation
└── CONTRIBUTING.md                       # Contribution guidelines
```

## Directory Purposes

**src/:**
- Root source directory containing all TypeScript source code
- Organized by concern: transports, domain handlers, utilities

**src/confluent/:**
- Core domain logic and handlers for Confluent services
- Contains API client management, tool registry, and all business logic

**src/confluent/tools/:**
- Tool handler implementations and factory
- `base-tools.ts` defines the ToolHandler interface
- `tool-factory.ts` is the central registry for all 50+ tools
- `tool-name.ts` enumerates all available tool names

**src/confluent/tools/handlers/:**
- Domain-organized handler implementations
- Each subdirectory represents a Confluent Cloud service (kafka, flink, schema, etc.)
- Handlers extend BaseToolHandler and implement tool-specific business logic

**src/confluent/tools/handlers/flink/:**
- All Flink-related tools (statement lifecycle, catalog, diagnostics)
- `flink-sql-helper.ts` provides shared Flink SQL execution utilities
- Subdirectories for different Flink concerns (catalog, diagnostics)

**src/mcp/transports/:**
- Protocol implementations for MCP communication
- `manager.ts` orchestrates lifecycle of all transports
- Supported transports: stdio (default), HTTP (REST), SSE (Server-Sent Events)
- Shared auth mechanism for HTTP/SSE

**assets/:**
- Static files (images, icons, etc.)
- Not part of compiled output

**.planning/codebase/:**
- Generated GSD analysis documents (ARCHITECTURE.md, STRUCTURE.md, etc.)
- Not committed to git

**.github/:**
- GitHub Actions workflows

**.semaphore/:**
- Semaphore CI/CD pipeline configuration

## Key File Locations

**Entry Points:**
- `src/index.ts` - Main server entry point (compiled to `dist/index.js`)
- `package.json` bin field: "mcp-confluent": "dist/index.js"

**Configuration:**
- `src/env.ts` - Environment variable loading and initialization
- `src/env-schema.ts` - Zod schema for environment validation
- `src/cli.ts` - CLI argument parsing with commander
- `.env.example` - Template for required environment variables

**Core Logic:**
- `src/confluent/client-manager.ts` - Service client management
- `src/confluent/tools/tool-factory.ts` - Tool registration and creation
- `src/confluent/tools/tool-name.ts` - Enum of all tool names (50+ tools)
- `src/mcp/transports/manager.ts` - Transport lifecycle management

**Testing:**
- No test files present in repository (type checking via `npm run test:ts`)

**Type Definitions:**
- `src/confluent/openapi-schema.d.ts` - Generated OpenAPI types (regenerated from openapi.json)
- `src/confluent/schema.ts` - Custom MCP-specific types (CallToolResult)

## Naming Conventions

**Files:**
- Handler files: `[action]-[domain]-handler.ts` (e.g., `list-topics-handler.ts`, `create-flink-statement-handler.ts`)
- Helper files: `[domain]-helper.ts` (e.g., `flink-sql-helper.ts`, `schema-registry-helper.ts`)
- Utility files: `[concern].ts` (e.g., `middleware.ts`, `helpers.ts`, `lazy.ts`)
- Configuration files: `[concern]-schema.ts` or `[concern].ts` (e.g., `env-schema.ts`, `env.ts`)

**Directories:**
- Service directories: lowercase service name (e.g., `kafka`, `flink`, `schema`, `connect`)
- Concern subdirectories within service: lowercase concern name (e.g., `catalog`, `diagnostics`, `topic`)

**Classes:**
- Handler classes: `[Action][Domain]Handler` (e.g., `ListTopicsHandler`, `CreateFlinkStatementHandler`)
- Manager classes: `[Domain]Manager` (e.g., `ClientManager`, `TransportManager`)
- Interfaces use same pattern with "I" prefix or service-specific names (e.g., `KafkaClientManager`, `ConfluentCloudRestClientManager`)

**Functions/Methods:**
- Handlers: `handle()` (required by interface)
- Configuration getters: `getToolConfig()`, `getRequiredEnvVars()`, `getToolConfigs()`
- State queries: `isConfluentCloudOnly()`
- Factories: `createToolHandler()`, `getToolConfig()`
- Helpers: Verb-first (e.g., `executeFlinkSql()`, `resolveCatalogName()`, `getEnsuredParam()`)

## Where to Add New Code

**New Tool (MCP Tool):**
1. Handler implementation: `src/confluent/tools/handlers/[service]/[action]-handler.ts`
   - Extend `BaseToolHandler`
   - Implement `handle()`, `getToolConfig()`, `getRequiredEnvVars()`
2. Tool name enum: Add entry to `src/confluent/tools/tool-name.ts`
3. Tool registration: Add to handlers map in `src/confluent/tools/tool-factory.ts`
4. If using Cloud REST API: Update `openapi.json` and regenerate `src/confluent/openapi-schema.d.ts`

**New Service Client:**
1. Create interface in `src/confluent/client-manager.ts` (e.g., `MyServiceClientManager`)
2. Add lazy-initialized getter to `DefaultClientManager` class
3. Create client with auth middleware from `src/confluent/middleware.ts`
4. Update `ClientManager` interface to extend new interface

**New Helper/Utility:**
1. For service-specific helpers: `src/confluent/[service]-helper.ts`
2. For general utilities: `src/confluent/helpers.ts` or `src/[concern].ts`
3. For Flink-specific helpers: `src/confluent/tools/handlers/flink/[concern]-helper.ts`

**New Transport:**
1. Implement `Transport` interface from `src/mcp/transports/types.ts`
2. Add new transport class to `src/mcp/transports/[transport-name].ts`
3. Register in `TransportManager.createTransport()` switch statement
4. Add transport type to `TransportType` enum in `src/mcp/transports/types.ts`
5. Add CLI flag in `src/cli.ts` if user-selectable

**Configuration/Environment Variables:**
1. Add to schema: `src/env-schema.ts`
2. Load in: `src/env.ts` (initEnv function)
3. Document in: `.env.example`
4. Reference in: `src/index.ts` where used

**CLI Command/Option:**
1. Add to `CLIOptions` interface in `src/cli.ts`
2. Add commander option/flag in `parseCliArgs()` function
3. Handle early (like `--generate-key`) or in `main()` as appropriate
4. Document usage in CLAUDE.md

## Special Directories

**dist/:**
- Purpose: Compiled JavaScript output
- Generated: By `npm run build` (tsc + tsc-alias)
- Committed: No (in .gitignore)
- Ownership: Build process only

**node_modules/:**
- Purpose: Installed dependencies
- Generated: By `npm install`
- Committed: No (in .gitignore)

**openapi.json:**
- Purpose: Confluent Cloud REST API specification
- Source: Confluent Cloud API documentation
- Usage: Generate types via `openapi-typescript` (to src/confluent/openapi-schema.d.ts)
- Committed: Yes (large, 4.4 MB file)

**.env.example:**
- Purpose: Template showing all configurable environment variables
- Committed: Yes
- Usage: Copy to `.env` and fill in actual values

---

*Structure analysis: 2026-03-11*
