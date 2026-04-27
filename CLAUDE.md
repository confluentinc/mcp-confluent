# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP (Model Context Protocol) server that exposes Confluent Cloud resources (Kafka, Flink, Schema Registry, Connectors, Tableflow, Billing) as tools for AI assistants. Built with TypeScript, Node.js ≥22, and the `@modelcontextprotocol/sdk`.

## Build & Development Commands

```bash
npm run build          # tsc && tsc-alias (compile + resolve path aliases)
npm run dev            # watch mode: tsc + tsc-alias in parallel
npm run lint           # eslint
npm run lint:fix       # eslint --fix
npm run format         # prettier --write
npm run test           # vitest run
npm run test:coverage  # vitest run --coverage
npm run typecheck      # tsc --noEmit (type-check only, includes test suite)
npm run start          # node dist/index.js --env-file .env (stdio transport)
npm run start:http     # HTTP transport
npm run start:all      # all transports (http, sse, stdio)
npm run inspector      # launch MCP inspector for manual testing
npm run print:schema   # print tool schemas as markdown
```

Pre-commit hook runs `npm run format && npm run lint` automatically via Husky.

## Architecture

### Entry Point & Startup Flow

`src/index.ts` → `parseCliArgs()` → `initEnv()` (Zod-validated env vars) → creates `DefaultClientManager` → iterates `ToolName` enum to build enabled tool set → registers tools on `McpServer` → starts transports.

Tools are **auto-enabled/disabled** based on which environment variables are present. Each handler declares its requirements via `getRequiredEnvVars()`. Cloud-only tools can be disabled with `--disable-confluent-cloud-tools`.

### Key Layers

- **`src/confluent/tools/`** — Tool system core:
  - `tool-name.ts` — `ToolName` enum; add new entries here when creating tools.
  - `base-tools.ts` — `BaseToolHandler` abstract class all handlers extend.
  - `tool-registry.ts` — `ToolHandlerRegistry.handlers` map: `ToolName` → handler instance. Wire new tools here.
  - `handlers/<domain>/` — Organized by Confluent service (kafka, flink, connect, catalog, schema, tableflow, billing, search).

- **`src/confluent/client-manager.ts`** — `DefaultClientManager` holds lazily-initialized Kafka clients (admin, producer, consumer via `@confluentinc/kafka-javascript`) and typed REST clients (`openapi-fetch`) for each Confluent Cloud API surface.

- **`src/confluent/openapi-schema.d.ts`** — Generated types from `openapi.json` using `openapi-typescript`. Provides type-safe REST calls throughout the codebase.

- **`src/mcp/transports/`** — Transport layer supporting stdio, HTTP (Streamable HTTP), and SSE. `TransportManager` orchestrates startup/shutdown. HTTP/SSE transports use Fastify and support API key auth + DNS rebinding protection.

- **`src/env-schema.ts`** — Zod schema defining all environment variables with defaults and validation. Merged from required (`envSchema`) and optional (`configSchema`) sections.

- **`src/confluent/middleware.ts`** — Auth middleware injected into `openapi-fetch` clients for Confluent Cloud API authentication.

### Path Aliases

`@src/*` maps to `src/*` (configured in `tsconfig.json`, resolved at build time by `tsc-alias`). Always use `@src/` imports for internal modules.

## Adding a New Tool

1. Add entry to `ToolName` enum in `src/confluent/tools/tool-name.ts`.
2. Create handler class extending `BaseToolHandler` in `src/confluent/tools/handlers/<domain>/`.
3. Implement `getToolConfig()` (name, description, Zod input schema), `handle()`, and `getRequiredEnvVars()`.
4. Register the handler in the `ToolHandlerRegistry.handlers` map in `src/confluent/tools/tool-registry.ts`.
5. If the tool calls a new Confluent Cloud REST endpoint, add it to `openapi.json` and regenerate types with `npm run generate:openapi-types`. Commit the updated `src/confluent/openapi-schema.d.ts` alongside the `openapi.json` change.

## Code Conventions

- ESM modules (`"type": "module"` in package.json); use `.js` extensions in import paths.
- Prettier + ESLint enforced; pre-commit hook runs both automatically via Husky.
- `noImplicitAny` is disabled in tsconfig due to OpenAPI type resolution issues.
- REST API calls use `openapi-fetch` with typed paths from the generated schema — prefer this over raw fetch.

## Unit Test Conventions

Tests are colocated as `*.test.ts` beside source files and run with Vitest. The authoritative
test-writing rule (assertions, stubbing patterns, handler test structure, fake timers) lives in
`.claude/rules/unit-tests.md` and auto-loads whenever you're editing a test file. The points
below affect source-code edits too, so they're called out here:

- **Design for stubbing.** External I/O (filesystem, env, network not mediated by `openapi-fetch`
  or Kafka clients, third-party constructors) must route through `src/confluent/node-deps.ts`
  so tests can spy on property lookups rather than ESM named imports. Extend that namespace
  before importing stubbable primitives directly at use sites. This is an ECMAScript-level
  constraint: ESM named imports are read-only from outside the defining module, so `vi.spyOn`
  can't intercept them directly. `vi.mock` is not used in this project; wrap the dependency
  in `node-deps.ts` and spy on the wrapper instead (rationale in `.claude/rules/unit-tests.md`).
- For handler-style tests that need a stubbed class instance, use `createMockInstance(Class)`
  from `@tests/stubs/index.js`; it returns a `Mocked<T>` with every method pre-stubbed as
  `vi.fn()`.
