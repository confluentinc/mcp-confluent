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

Pre-commit hook runs `npm run format && npm run lint` automatically via Husky. Pre-push hook runs `npm run lint && npm run typecheck` across the whole repo.

## Architecture

### Entry Point & Startup Flow

`src/index.ts` → `parseCliArgs()` → `initEnv()` → branch on `cliOptions.config`: when `-c <path>` is supplied, `loadConfigFromYaml(path, process.env)` parses + interpolates + validates the YAML; otherwise `buildConfigFromEnvAndCli(env, ...)` synthesizes the same `MCPServerConfiguration` shape from env vars + CLI args (legacy path, see issue #151). Both branches converge into `ServerRuntime.fromConfig()`, which constructs a `DefaultClientManager` per connection → iterates `ToolName` enum to build enabled tool set → registers tools on `McpServer` → starts transports.

Tools are **auto-enabled/disabled** based on which **service blocks** are present in each connection (e.g., a tool requiring `flink` is enabled iff some connection's resolved config has a `flink:` block). The connection's blocks come from YAML when one is supplied via `-c <path>`; otherwise they're synthesized from env vars + CLI args for backwards compatibility during the migration. Each handler declares its requirement via `enabledConnectionIds(runtime)`, which returns the ids of connections satisfying a predicate from `src/confluent/tools/connection-predicates.ts`. An empty result disables the tool. Domain-wide gating (e.g., all Flink tools) lives on intermediate base classes such as `FlinkToolHandler`.

### Key Layers

- **`src/config/`** — Configuration core. `models.ts` defines `MCPServerConfiguration` (a Zod schema with per-service connection blocks: `kafka`, `flink`, `schema_registry`, `confluent_cloud`, `tableflow`, `telemetry`). `index.ts` exposes `loadConfigFromYaml()` for the `-c <path>` branch (parsing, `${VAR}` interpolation via `interpolation.ts`, Zod validation). `env-config.ts` exports `buildConfigFromEnvAndCli()` for the legacy env-var + CLI path. Both produce an `MCPServerConfiguration`.

- **`src/confluent/tools/`** — Tool system core:
  - `tool-name.ts` — `ToolName` enum; add new entries here when creating tools.
  - `base-tools.ts` — `BaseToolHandler` abstract class all handlers extend (directly or via a domain subclass like `FlinkToolHandler`).
  - `connection-predicates.ts` — `hasKafka`, `hasFlink`, `hasSchemaRegistry`, etc., plus `connectionIdsWhere(connections, predicate)`. The vocabulary handlers use to express their enablement requirement.
  - `tool-registry.ts` — `ToolHandlerRegistry.handlers` map: `ToolName` → handler instance. Wire new tools here.
  - `handlers/<domain>/` — Organized by Confluent service (kafka, flink, connect, catalog, schema, tableflow, billing, search, metrics, environments, clusters). Some domains expose an intermediate base class (e.g., `flink-tool-handler.ts`) that implements `enabledConnectionIds()` once for the whole domain.

- **`src/confluent/client-manager.ts`** — `DefaultClientManager` holds lazily-initialized Kafka clients (admin, producer, consumer via `@confluentinc/kafka-javascript`) and typed REST clients (`openapi-fetch`) for each Confluent Cloud API surface. One instance per connection, constructed from a `ConnectionConfig` (not directly from env vars).

- **`src/confluent/openapi-schema.d.ts`** — Generated types from `openapi.json` using `openapi-typescript`. Provides type-safe REST calls throughout the codebase.

- **`src/mcp/transports/`** — Transport layer supporting stdio, HTTP (Streamable HTTP), and SSE. `TransportManager` orchestrates startup/shutdown. HTTP/SSE transports use Fastify and support API key auth + DNS rebinding protection.

- **`src/env-schema.ts`** — Zod schema for the legacy env-var path. Still consulted when no YAML file is provided, but the configuration that flows through the rest of the app is the resolved `MCPServerConfiguration` from `src/config/`, not the raw env. Slated to shrink as the YAML migration completes (see issue #151 and follow-ups).

- **`src/confluent/middleware.ts`** — Auth middleware injected into `openapi-fetch` clients for Confluent Cloud API authentication.

### Path Aliases

`@src/*` maps to `src/*` (configured in `tsconfig.json`, resolved at build time by `tsc-alias`). Always use `@src/` imports for internal modules.

## Adding a New Tool

Detailed conventions (handler structure, input schema rules, registration checklist, predicate selection) live in `.claude/rules/tool-handlers.md`, which auto-loads when you edit `src/confluent/tools/**/*.ts`. The high-level shape:

1. Add entry to `ToolName` enum in `src/confluent/tools/tool-name.ts`.
2. Create handler class in `src/confluent/tools/handlers/<domain>/`. Extend the domain subclass if one exists (e.g., `FlinkToolHandler`); otherwise extend `BaseToolHandler` directly and implement `enabledConnectionIds(runtime)` using a predicate from `connection-predicates.ts`.
3. Implement `getToolConfig()` (name, description, Zod input schema, `annotations`) and `handle()`.
4. Register the handler in the `ToolHandlerRegistry.handlers` map in `src/confluent/tools/tool-registry.ts`.
5. If the tool calls a new Confluent Cloud REST endpoint, add it to `openapi.json` and regenerate types with `npm run generate:openapi-types`. Commit the updated `src/confluent/openapi-schema.d.ts` alongside the `openapi.json` change.

## Code Conventions

- ESM modules (`"type": "module"` in package.json); use `.js` extensions in import paths.
- Prettier + ESLint enforced; pre-commit hook runs both automatically via Husky. `eslint --fix` auto-removes unused imports via `eslint-plugin-unused-imports`, so stale imports left during a migration are cleaned up at commit time without manual intervention. Pre-push hook runs full-repo `lint` + `typecheck` so CI failures on those checks are nearly impossible.
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
