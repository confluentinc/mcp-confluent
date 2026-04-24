# mcp-confluent

## Project Overview

MCP (Model Context Protocol) server that exposes Kafka-ecosystem and Confluent tooling to AI
assistants. The tool surface splits into two groups:

- **Kafka-protocol tools** that work against any Apache Kafka®-compatible cluster or Schema
  Registry (e.g., topic CRUD, producing and consuming messages, schema management).
- **Confluent Cloud-specific tools** that wrap CCloud REST APIs (e.g., Flink, Tableflow,
  billing), collectively disable-able via the `--disable-confluent-cloud-tools` CLI switch.

Built with TypeScript, Node.js ≥22, and the `@modelcontextprotocol/sdk`. Ships as an npm package
and a Docker image; supports stdio, Streamable HTTP, and (for backwards compatibility with older
MCP clients) the legacy HTTP+SSE transport.

These instructions exist to keep GitHub Copilot PR reviews focused on the invariants that matter in
this codebase. Author-facing guidance (how to scaffold a tool, run the inspector, etc.) lives in
`CONTRIBUTING.md` and `CLAUDE.md` — refer to those rather than repeating them here.

## Architecture (what reviewers need to know)

### Entry flow

At startup the server parses CLI arguments, loads and validates configuration, constructs the
shared client manager, builds the set of enabled tools, registers them, and starts the configured
transports.

**Tools are auto-enabled/disabled** at startup based on the available configuration: handlers
declare which config surfaces they need, and the server only exposes the ones whose requirements
are satisfied. Cloud-only tools can be disabled with `--disable-confluent-cloud-tools`.

### Key layers

- **`src/confluent/tools/`** — Tool system core:
  - `tool-name.ts` — `ToolName` enum; every tool has an entry here.
  - `base-tools.ts` — `BaseToolHandler` abstract class all handlers extend.
  - `tool-registry.ts` — `ToolHandlerRegistry.handlers` maps `ToolName` → handler instance.
    Wiring must be complete here for a tool to exist.
  - `handlers/<domain>/` — organized by service (e.g., `kafka/`, `schema/`, `flink/`); new
    handlers go under the matching domain or a new one if no fit exists.

- **`src/confluent/client-manager.ts`** — `DefaultClientManager` holds lazily-initialized Kafka
  clients (admin/producer/consumer via `@confluentinc/kafka-javascript`) and typed `openapi-fetch`
  REST clients for each Confluent Cloud API surface.

- **`src/confluent/openapi-schema.d.ts`** — generated from `openapi.json` via
  `npm run generate:openapi-types` (openapi-typescript). Never hand-edited.

- **`src/confluent/node-deps.ts`** — namespace-object wrapper around Node builtins, third-party
  constructors, and env access. ESM named imports are read-only from outside the defining
  module, so `vi.spyOn` can't intercept them directly; routing those dependencies through a
  namespace object lets tests spy on property access instead. All external I/O that isn't
  mediated by `openapi-fetch` or the Kafka clients must route through this module.

- **`src/mcp/transports/`** — stdio, HTTP (Streamable HTTP), and SSE transports built on Fastify.
  HTTP/SSE support API-key auth and DNS rebinding protection.

- **Server configuration** — loaded and schema-validated at startup into a typed object. Each
  handler's declared configuration dependencies resolve against this object, and that resolution
  determines which tools the server exposes.

### Path aliases and module format

- ESM modules (`"type": "module"`). **Always use `.js` extensions in import paths**, even when
  importing `.ts` files.
- `@src/*` maps to `src/*` and `@tests/*` maps to `tests/*` (both resolved by `tsc-alias` at
  build time). Prefer the path aliases for internal imports. Relative paths are acceptable for
  root-level artifacts like `package.json`, or in other cases where the aliases don't apply.

## Code Review Guidelines (GitHub PR Reviews)

When reviewing pull requests for this project, focus on the checkpoints below. Let ESLint and
Prettier handle formatting — don't comment on style the tooling already enforces.

### 1. Tool registration is complete

A new tool requires edits in **exactly three places**. Missing any one of these means the tool
either doesn't exist or doesn't run:

1. `src/confluent/tools/tool-name.ts` — new `ToolName` enum entry.
2. A new handler file under `src/confluent/tools/handlers/<domain>/` — handler class extending
   `BaseToolHandler` and implementing its abstract methods.
3. `src/confluent/tools/tool-registry.ts` — import + entry in the `ToolHandlerRegistry.handlers`
   Map.

### 2. Handler declarations are correct

What a handler declares — via `getToolConfig()` and its metadata methods — shapes both correctness
and how the AI assistant uses the tool. Reviewers should verify each of these:

- **Tool annotations** (`READ_ONLY`, `CREATE_UPDATE`, `DESTRUCTIVE` from `base-tools.ts`) are
  client-side UX hints (used for things like confirmation prompts), **not** server-side
  enforcement. Pick the one that matches the tool's actual behavior, but don't treat `READ_ONLY`
  as a safety guarantee — the implementation still has to avoid mutations.
- **Input schema** should always be provided to `getToolConfig()`. For tools with parameters,
  use a Zod object schema's `.shape` and make sure each field has a `.describe()` call (those
  descriptions surface to the AI assistant as parameter docs). For tools with no parameters,
  provide an empty object (`inputSchema: {}`), not omit the field.
- **Config dependencies** drive auto-enablement: each handler declares what configuration it
  needs, and the server skips exposing tools whose requirements aren't satisfied. A missing
  declaration silently breaks the tool on servers where that config isn't set — it registers,
  then fails at call time with a confusing error. Check that declared dependencies match what the
  handler actually reads.

### 3. Type safety

- **No `any` types.** `noImplicitAny` is disabled in `tsconfig.json` (a workaround for OpenAPI type
  resolution), which means implicit `any` slips through type-check. Review explicitly for it.
- Prefer the `openapi-fetch` typed clients over raw `fetch`; the types in `openapi-schema.d.ts`
  are the source of truth for Confluent Cloud request/response shapes.
- Prefer `enum` over string union types for constants with semantic meaning (see `ToolName`).
- New public classes and exported functions get JSDoc.

### 4. Error handling

- Never silently swallow exceptions.
- Log via the pino logger in `src/logger.ts`, or rethrow after enrichment.
- Return errors through `this.createResponse(message, isError, _meta?)` on `BaseToolHandler`.
- Set `isError: true` on error results.
- Write actionable error messages: say what happened and, where useful, how to resolve it.
- Name the missing or invalid config in auth/configuration errors, so users don't have to read
  source to debug.

### 5. Stubbable boundaries

- External I/O (filesystem, process env, network not mediated by `openapi-fetch` or Kafka clients)
  should go through `src/confluent/node-deps.ts` so unit tests can spy on it via `vi.spyOn`. If a
  PR introduces a new direct node-module dependency, push back and ask for it to be routed through
  `node-deps.ts`.
- New configuration reads should go through the schema-validated config layer, not `process.env`
  or ad-hoc file reads.

### 6. Transport and auth changes

- Anything under `src/mcp/transports/` is security-sensitive. For the HTTP-based transports,
  verify all three DNS-rebinding and auth mitigations still apply to every endpoint: `Host`
  header allowlisting (via `MCP_ALLOWED_HOSTS`, enforced by `src/mcp/transports/auth.ts`),
  localhost-only binding in local dev, and authentication on all requests. The `--disable-auth`
  flag is for local dev only — guard the README/CONTRIBUTING wording if it's touched.
- Long-running resources (listeners, intervals, streams) added to transport code need explicit
  teardown in the `TransportManager` shutdown path.

### 7. Testing

- New behavior needs unit tests. Tests are co-located as `*.test.ts` next to the file under test
  and run with Vitest.
- Stub external interactions with `vi.spyOn` (preferred) or `vi.fn()`. `vitest.config.ts` sets
  `restoreMocks: true`, so every spy is auto-restored after each test, and no per-test
  `afterEach` restore hooks are needed. Shared stub helpers live in `tests/stubs/`; test data
  factories live in `tests/factories/`.
- ESM named imports are read-only from outside the defining module per the ECMAScript spec, so
  `vi.spyOn` can't intercept a `import { readFileSync } from "node:fs"` at a call site. The
  project's convention is to route such dependencies through `src/confluent/node-deps.ts` so
  callers access them via property lookup, and tests spy on those properties. Project-local
  helpers that compose around already-wrapped primitives don't need their own namespace object;
  tests stub the underlying primitive instead.
- **`vi.mock` is not used in this project, by design.** It's a different mechanism from
  `vi.spyOn` (module graph rewrite vs. runtime property mutation) and the tradeoffs go the
  wrong way for this codebase: file-scoped mock state instead of per-test granularity, reduced
  type safety on the real-module boundary, no equivalent for accessor-mode spies
  (`vi.spyOn(obj, "prop", "get")`), and hoisting surprises. Every dependency that currently
  needs stubbing can be handled by wrapping + `vi.spyOn`. Flag PRs that introduce `vi.mock`
  and ask for a namespace-object wrapping instead.
- Outer `describe()` per file, inner `describe()` per class/function, `it("should ...")` per
  behavior.

## Files to skip in reviews (auto-generated or artifact)

Do not comment on these for style, patterns, or best practices (build artifacts, `node_modules`,
coverage output, etc. are already excluded via `.gitignore` and won't appear in diffs):

- `src/confluent/openapi-schema.d.ts` — generated from `openapi.json` by
  `npm run generate:openapi-types`. The "OpenAPI Types" CI job re-runs the generator and fails on
  drift; trust it. Never hand-edit this file.
- `openapi.json` — a vendored snapshot of the public Confluent Cloud API spec, not this project's
  own contract. It's only edited when a handler needs a Confluent Cloud endpoint the snapshot
  doesn't yet cover. Don't nitpick its contents.

## Style preferences (avoid nitpicking)

- `import type { ... }` vs `import { ... }` — both are valid; TypeScript's `verbatimModuleSyntax`
  isn't enforced here. Don't request changes solely over this.
- Formatting and import ordering are owned by Prettier + `prettier-plugin-organize-imports`, which
  run in the Husky pre-commit hook. Don't comment on whitespace, quote style, or import order.
- Focus reviews on logic, architecture, testing, and the checkpoints above.

## Review checklist

Before approving, confirm:

- [ ] New tools touch all three registration points (`ToolName` enum, handler file,
      `ToolHandlerRegistry.handlers`), and the handler's declared config dependencies reflect
      what it actually reads.
- [ ] No `any` types introduced; types come from `openapi-schema.d.ts` where applicable.
- [ ] Error paths surface actionable messages; exceptions are logged or rethrown, never swallowed.
- [ ] New external I/O is stubbable (routed through `node-deps.ts` or typed API clients).
- [ ] Transport/auth changes preserve existing protections and clean up resources on shutdown.
- [ ] New behavior has co-located Vitest tests (with stubbed externals if needed).
- [ ] If `openapi.json` was edited, `openapi-schema.d.ts` was regenerated (or the OpenAPI Types CI
      job is green).
- [ ] PR description and applicable checklist items in `.github/pull_request_template.md` are
      filled in; CHANGELOG is updated for user-visible changes.
