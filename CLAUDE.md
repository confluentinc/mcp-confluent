# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP (Model Context Protocol) server that exposes Confluent Cloud resources (Kafka, Flink, Schema Registry, Connectors, Tableflow, Billing) as tools for AI assistants. Built with TypeScript, Node.js ≥22, and the `@modelcontextprotocol/sdk`.

## Build & Development Commands

```bash
pnpm run build          # tsc && tsc-alias (compile + resolve path aliases)
pnpm run dev            # watch mode: tsc + tsc-alias in parallel
pnpm run lint           # eslint
pnpm run lint:fix       # eslint --fix
pnpm run format         # prettier --write
pnpm run test                       # unit + integration (live CCloud, builds first)
pnpm run test:unit                  # unit tests only (fast, no build)
pnpm run test:unit:watch            # unit tests in watch mode
pnpm run test:unit:coverage         # unit tests with coverage
pnpm run test:integration           # integration tests only (live CCloud, builds first)
pnpm run test:integration:coverage  # integration tests with coverage
pnpm run test:coverage              # unit + integration with coverage
pnpm run typecheck                  # tsc --noEmit (type-check only, includes test suite)
pnpm run start          # node dist/index.js --env-file .env (stdio transport)
pnpm run start:http     # HTTP transport
pnpm run start:all      # all transports (http, sse, stdio)
pnpm run inspector      # launch MCP inspector for manual testing
pnpm run print:schema   # print tool schemas as markdown
```

Pre-commit hook runs `pnpm exec prettier` and `pnpm exec eslint` automatically via Husky on staged files only. Pre-push hook runs `pnpm run lint` and `pnpm run typecheck` in parallel.

## Architecture

### Entry Point & Startup Flow

`src/index.ts` → `parseCliArgs()` → `initEnv()` → branch on `cliOptions.config`: when `-c <path>` is supplied, `loadConfigFromYaml(path, process.env)` parses + interpolates + validates the YAML; otherwise `buildConfigFromEnvAndCli(env, ...)` synthesizes the same `MCPServerConfiguration` shape from env vars + CLI args. Both branches converge into `ServerRuntime.fromConfig()`, which constructs a `DirectClientManager` per connection → iterates `ToolName` enum to build enabled tool set → registers tools on `McpServer` → starts transports.

YAML is the preferred path; the env-var path is the legacy synthesizer. It still has parity for a single connection, but it's slated for a startup warning in a near-future release and removal a release or two later (issue #151 and follow-ups). Don't write new code that reaches into the legacy synthesizer. The user-facing version of this story lives in `CONFIGURATION.md`.

Tools are **auto-enabled/disabled** based on which **service blocks** are present in each connection (e.g., a tool requiring `flink` is enabled iff some connection's resolved config has a `flink:` block). The connection's blocks come from YAML when one is supplied via `-c <path>`; otherwise they're synthesized from env vars + CLI args for backwards compatibility during the migration. Each handler declares its requirement via a `predicate` property pointing at a named export from `src/confluent/tools/connection-predicates.ts`; `BaseToolHandler` derives `enabledConnectionIds(runtime)` and `connectionVerdicts(runtime)` from it. Domain-wide gating (e.g., all Flink tools) lives on intermediate base classes such as `FlinkToolHandler`.

### Key Layers

- **`src/config/`** — Configuration core. `models.ts` defines `MCPServerConfiguration` (a Zod schema with per-service connection blocks: `kafka`, `flink`, `schema_registry`, `confluent_cloud`, `tableflow`, `telemetry`). `index.ts` exposes `loadConfigFromYaml()` for the `-c <path>` branch (parsing, `${VAR}` interpolation via `interpolation.ts`, Zod validation). `env-config.ts` exports `buildConfigFromEnvAndCli()` for the legacy env-var + CLI path. Both produce an `MCPServerConfiguration`.

- **`src/confluent/tools/`** — Tool system core:
  - `tool-name.ts` — `ToolName` enum; add new entries here when creating tools.
  - `base-tools.ts` — `BaseToolHandler` abstract class all handlers extend (directly or via a domain subclass like `FlinkToolHandler`).
  - `connection-predicates.ts` — `hasKafka`, `hasFlink`, `hasSchemaRegistry`, etc., plus `connectionIdsWhere(connections, predicate)`. The vocabulary handlers use to express their enablement requirement.
  - `tool-registry.ts` — `ToolHandlerRegistry.handlers` map: `ToolName` → handler instance. Wire new tools here.
  - `handlers/<domain>/` — Organized by Confluent service (kafka, flink, connect, catalog, schema, tableflow, billing, search, metrics, environments, clusters). Some domains expose an intermediate base class (e.g., `flink-tool-handler.ts`) that implements `enabledConnectionIds()` once for the whole domain.

- **`src/confluent/client-manager.ts`** — public client-manager contracts: `ClientManager`, `KafkaClientManager`, `ConfluentCloudRestClientManager`, `SchemaRegistryClientHandler`. Implementations live in sibling files.
- **`src/confluent/base-client-manager.ts`** — abstract `BaseClientManager` that owns every Confluent Cloud REST client (`openapi-fetch`) and the Schema Registry SDK client. No native Kafka broker.
- **`src/confluent/direct-client-manager.ts`** — concrete `DirectClientManager` (extends `BaseClientManager`) that adds api-key-authenticated Kafka admin/producer/consumer via `@confluentinc/kafka-javascript`. Built once per connection from a `DirectConnectionConfig` by `constructDirectClientManager`.

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
5. If the tool calls a new Confluent Cloud REST endpoint, add it to `openapi.json` and regenerate types with `pnpm run generate:openapi-types`. Commit the updated `src/confluent/openapi-schema.d.ts` alongside the `openapi.json` change.

## Code Conventions

- ESM modules (`"type": "module"` in package.json); use `.js` extensions in import paths.
- Prettier + ESLint enforced; pre-commit hook runs both automatically via Husky. `eslint --fix` auto-removes unused imports via `eslint-plugin-unused-imports`, so stale imports left during a migration are cleaned up at commit time without manual intervention. Pre-push hook runs full-repo `lint` + `typecheck` so CI failures on those checks are nearly impossible.
- `noImplicitAny` is disabled in tsconfig due to OpenAPI type resolution issues.
- REST API calls use `openapi-fetch` with typed paths from the generated schema — prefer this over raw fetch.
- Application code reads configuration from `MCPServerConfiguration` / `ConnectionConfig`, never from `process.env`. A `no-restricted-syntax` rule in `eslint.config.mjs` enforces this; the only bootstrap files exempt are `src/index.ts`, `src/cli.ts`, `src/env.ts`, `src/logger.ts`. The `-e` dotenv mutation in `cli.ts` is intentional — it seeds env vars for linked C/Node libraries (OpenSSL, cyrus-sasl, krb5, undici) that read `process.env` outside our control.
- When adding or renaming a field on a connection arm or service block in `src/config/models.ts`, classify it in the matching `*_FIELD_VISIBILITY` map in `src/confluent/tools/handlers/diagnostics/describe-fields.ts` — `tsc` and `describe-fields.test.ts` fail until you do. This is what keeps the `describe-configured-connection` card from leaking secrets or silently dropping a new knob. See `.claude/rules/config-fields.md`.
- Always pass an explicit comparator to `.sort()` / `.toSorted()` — never a bare call. Bare `Array.prototype.sort()` coerces elements to strings (so `[2, 10]` sorts to `[10, 2]`), and SonarQube (which gates CI) flags every comparator-less call as `typescript:S2871`. For strings use `(a, b) => a.localeCompare(b)`; for numbers `(a, b) => a - b`. This holds even when the elements are already strings and the default order happens to be correct — the comparator states the intent and survives a later element-type change.
- Keep cognitive complexity ≤ 15. A `sonarjs/cognitive-complexity` ESLint rule in `eslint.config.mjs` (scoped to non-test `src`) mirrors SonarQube's `typescript:S3776` gate locally, so `pnpm run lint` and the pre-push hook catch an over-complex function before CI. Prefer refactoring into focused helpers (an orchestrator that reads like a table of contents) over suppressing. A genuinely unavoidable case gets an inline `// eslint-disable-next-line sonarjs/cognitive-complexity -- <reason> (#NNN)` citing a tracking issue; the grandfathered debt baselined at rule introduction is tracked under epic #654.

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
- **Test-only helpers belong in test files.** Functions that exist solely to support tests (builders, factories, convenience wrappers around production code) must live in `*.test.ts` files or under `tests/`. Do not export them from production source files — they bloat the public API surface and obscure what the module actually provides to callers.

## Integration Test Conventions

Integration tests spawn the real MCP server as a child process and exercise it against a real Confluent Cloud account over both stdio and streamable HTTP transports. Full rule at `.claude/rules/integration-tests.md` (auto-loads when editing `*.integration.test.ts` or `tests/harness/**`).

- Colocate next to the handler: `my-handler.integration.test.ts` alongside `my-handler.ts`; tag with `{ tags: ["@<group>"] }` on the outer describe.
- Run with `pnpm run test:integration --tags-filter=@kafka` (one tool group). Do **not** insert a `--` separator before filter args — pnpm 10 preserves it and vitest 4 then drops the filter and runs the whole suite; pass `--tags-filter` / a file path / `-t "<name>"` bare. Local creds live in `.env.integration` (gitignored; example in `.env.integration.example`).
- Use the `startServer({ transport, env? })` harness from `@tests/harness/start-server.js`; it handles the `NODE_ENV=test` guard, HTTP auth disable, and free-port allocation.
- Gate on creds with an early-return inside the describe body (`if (!hasCreds) { it.skip(reason); return; }`), **not** `describe.skipIf` — the latter still runs nested hooks in vitest 4.
- Any run that can collect more than one OAuth test file needs `--no-file-parallelism`: OAuth describes block on a single hard-coded callback port and _fail-fast_ (lock balks, naming the holder PID) on concurrency rather than queuing. `make test-integration` adds the flag for non-direct runs; a broad raw `pnpm run test:integration` with OAuth creds present does not, so it collides. Scoping to one file or running direct-only also avoids it.
