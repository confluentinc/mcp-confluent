---
paths:
  - src/**/*.integration.test.ts
  - tests/harness/**
---

# Integration Testing (Vitest)

Integration tests spawn the real MCP server as a child process and exercise it
over the stdio, streamable HTTP, and SSE transports against a real Confluent
Cloud account. This rule covers what's specific to integration testing; the broader
vitest fundamentals in [unit-tests.md](./unit-tests.md) (describe/it/expect,
`restoreMocks`, path aliases, `createMockInstance`) still apply when the two
don't conflict.

## Location & Naming

- Colocate integration tests next to the handler they exercise, using the
  `.integration.test.ts` suffix. Example: `list-topics-handler.integration.test.ts`
  sits next to `list-topics-handler.ts` in `src/confluent/tools/handlers/kafka/`.
- Do NOT put integration test files under `tests/` — only shared harness,
  stubs, factories, and fixtures live there.
- Tag the outermost `describe` with the tool group via the `Tag` enum from
  `@tests/tags.js` (e.g. `{ tags: [Tag.KAFKA] }`). `tests/tags.ts` is the
  single source of truth; `vitest.config.ts` derives its `test.tags` list
  from the same enum, so adding a new tool group means editing one file.

## Running Tests Locally

- `npm run test` — full sweep: builds `dist/` then runs both unit and
  integration projects.
- `npm run test:unit` — unit tests only (fast, no build).
- `npm run test:integration` — integration tests only (builds `dist/` then
  runs `--project integration`).
- `npm run test:integration -- --tags-filter=@kafka` — one tool group at a time.

Set up local creds by copying `.env.integration.example` to `.env.integration`
and filling in the vars your chosen tests need. `tests/harness/setup.ts` loads
that file automatically via dotenv.

## Vitest Project Config (`vitest.config.ts`)

The `integration` project differs from `unit` in a few specific ways — if you
find yourself reaching for any of these per-test, consider whether the
project-level setting should change instead:

- `testTimeout: 60_000`, `hookTimeout: 60_000` — server spawn + cold CCloud
  round-trips blow past the 10s unit default.
- `pool: "forks"` — one worker per test file so each file spawns its own MCP
  server and binds its own HTTP port without collisions.
- `setupFiles: ["tests/harness/setup.ts"]` — loads `.env.integration` via
  dotenv. Intentionally has no required-vars check; each test gates on just
  the creds it needs.

## Harness API

Integration-specific helpers live under `tests/harness/` alongside more generic scaffolding -
the directory is named by what's in it (test harness infrastructure), not by which test type
consumes it. This matches the sibling pattern (`tests/stubs/`, `tests/factories/`) where each
directory is named for the _kind_ of utility inside, not for a specific test suite.

Import from `@tests/harness/start-server.js`:

```ts
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
```

The harness uses `TransportType` from `@src/mcp/transports/types.js` directly,
so callers don't need a separate `Transport` alias.

`startServer({ transport, env? })` spawns the server as a child process and
returns `{ client, stop }` where `client` is an `@modelcontextprotocol/sdk`
`Client` connected over the requested transport.

The optional `env` record **merges over** `process.env` (it doesn't replace it),
so base credentials loaded from `.env.integration` stay visible to the child.
Use it when a single test needs to override a specific var, e.g. pointing one
test at a different Schema Registry:

```ts
server = await startServer({
  transport,
  env: { SCHEMA_REGISTRY_ENDPOINT: "https://test-sr.example" },
});
```

Three non-obvious things the harness does for you:

1. Forces `NODE_ENV=integration` in the child env. `src/index.ts` guards
   `main()` with `if (process.env.NODE_ENV !== "test")` so the module can be
   imported by unit tests — without the override, vitest's default
   `NODE_ENV=test` would cause the child to exit without starting the server.
2. For HTTP and SSE, sets `MCP_AUTH_DISABLED=true` — tests run on 127.0.0.1
   with DNS rebinding protection still active, so skipping the API-key header
   exchange is safe and means you don't need `MCP_API_KEY` in
   `.env.integration`. (Both transports share the same Fastify auth hook, so
   the same flag covers them.)
3. For HTTP and SSE, calls `findFreePort()` to allocate a fresh TCP port per
   test file. Tests can run in parallel even if `npm run start:http` is
   already bound to 8080 locally.

Always call `stop()` in `afterAll` to tear down the child process. The harness
awaits the child's exit event symmetrically for both transports.

## Canonical Test Structure

```ts
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const hasKafkaCreds = Boolean(
  process.env.BOOTSTRAP_SERVERS &&
    process.env.KAFKA_API_KEY &&
    process.env.KAFKA_API_SECRET,
);

describe("my-handler", { tags: [Tag.KAFKA] }, () => {
  // early-return short-circuits the describe body when creds are absent.
  // see "Skip Pattern" below for why this isn't `describe.skipIf`.
  if (!hasKafkaCreds) {
    it.skip("requires BOOTSTRAP_SERVERS, KAFKA_API_KEY, KAFKA_API_SECRET", () => {});
    return;
  }

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should ...", async () => {
      const result = await server.client.callTool({
        name: ToolName.MY_TOOL,
        arguments: {},
      });
      expect(result.isError).not.toBe(true);
      expect(textContent(result)).toMatch(/expected prefix/);
    });
  });
});
```

## Asserting on Tool Output

Use `textContent(result)` from `@tests/harness/tool-results.js` instead of
hand-rolling the `Array.isArray` + type-predicate + `.filter().map().join("")`
dance. The helper handles the SDK's `CompatibilityCallToolResult` union
(where the legacy variant has no `content` field at all) and joins all
text-typed content blocks into one string:

```ts
import { textContent } from "@tests/harness/tool-results.js";

expect(textContent(result)).toMatch(/^Kafka topics:/);
```

`BaseToolHandler.createResponse()` always emits one text block, so in
practice the helper returns that block's text. For typed payloads, prefer
`result.structuredContent` when the handler sets `_meta` via its third arg.

## Skip Pattern for Missing Credentials

Do **NOT** use `describe.skipIf(!hasCreds)`. In vitest 4 it marks tests as
skipped but still synchronously executes the describe body, which means
nested `describe.each` hooks register and their `beforeAll`s run — and the
harness's server spawn then hits the hook timeout.

Use the early-return pattern shown above: a plain `if (!hasCreds) { it.skip(reason); return; }` at the top of the describe body. The placeholder
`it.skip()` keeps the file visible in vitest reports with a clear reason line.

## Credential Gating by Tool Domain

Scope each test's skip gate to exactly what the handler needs — authoritative
list is the handler's `getRequiredEnvVars()`. Common groupings:

- Kafka admin (`list-topics`, `create-topics`, `delete-topics`,
  `produce-message`, `consume-messages`): `BOOTSTRAP_SERVERS`, `KAFKA_API_KEY`,
  `KAFKA_API_SECRET`.
- Kafka REST (`get-topic-config`, `alter-topic-config`): above plus
  `KAFKA_REST_ENDPOINT`.
- CCloud control plane (`list-clusters`, `list-environments`, connectors,
  billing): `CONFLUENT_CLOUD_API_KEY`, `CONFLUENT_CLOUD_API_SECRET`.
- Flink: `FLINK_REST_ENDPOINT`, `FLINK_API_KEY`, `FLINK_API_SECRET`.
- Schema Registry: `SCHEMA_REGISTRY_ENDPOINT`, `SCHEMA_REGISTRY_API_KEY`,
  `SCHEMA_REGISTRY_API_SECRET`.

## Write-Path Tests (Lifecycle Management)

Handlers that mutate state (`create-topics`, `delete-topics`,
`produce-message`, `alter-topic-config`) must create their own resources in
`beforeAll` and clean up in `afterAll`. Always use unique names so parallel
runs and retried CI jobs don't collide.

**Naming convention**: `int-<slug>-<timestamp>-<random>` via the
`uniqueTopicName(slug)` helper in `@tests/harness/kafka-admin.js`. The `int-`
prefix matches what the confluentinc/vscode repo uses (`e2e-`) for
identifying test-created resources during cleanup of orphaned state.

```ts
import {
  connectTestAdmin,
  uniqueTopicName,
} from "@tests/harness/kafka-admin.js";

const topic = uniqueTopicName("create"); // e.g. "int-create-1729123456789-a7f3b2"

beforeAll(async () => {
  admin = await connectTestAdmin();
  await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] });
});

afterAll(async () => {
  await admin.deleteTopics({ topics: [topic] }).catch(() => {});
  await admin.disconnect();
});
```

Set up and tear down resources at the **outer** describe level (before
`describe.each`) so both transports share one topic — fewer CCloud API round
trips.

### Verifying state on a separate admin client

CCloud propagates Kafka metadata asynchronously. A test-side admin client's
`listTopics()` right after a handler's CREATE_TOPICS / DELETE_TOPICS call can
lag the broker by a few seconds, because the handler's admin and the test's
admin have separate metadata caches. Use `expect.poll` instead of a single
snapshot — it retries the value-fetcher until the matcher passes or the
timeout elapses, with vitest-native assertion frames on failure:

```ts
// wait for the topic to appear after create
await expect
  .poll(() => admin.listTopics(), { timeout: 15_000, interval: 500 })
  .toContain(topic);

// wait for it to disappear after delete
await expect
  .poll(() => admin.listTopics(), { timeout: 15_000, interval: 500 })
  .not.toContain(topic);
```

Don't rely on state from other test files; each file has its own server
process and files may run in any order.

## Transport Filtering

`activeTransports` (from `@tests/harness/transports.js`) is the iterable that
each test file's `describe.each` receives. It honors the
`INTEGRATION_TEST_TRANSPORT` env var:

- **unset** → iterate every transport (default for local runs / full coverage)
- **`stdio`**, **`http`**, or **`sse`** → iterate only that transport

Skipped-transport iterations are never registered, so their `beforeAll`s don't
spawn servers. `make test-integration TRANSPORT=stdio` sets the env var; CI
sets it per-block (see CI Matrix below).

## CI Matrix

`.semaphore/integration.yml` is structured like vscode's `playwright-e2e.yml`:
one block per MCP transport (stdio, http, and sse), each skippable via the
`TRANSPORTS` pipeline parameter. Within a block, jobs parallelize across
tool groups (the `TOOL_GROUP` matrix axis).

Adding a new tool group means:

1. Add `*.integration.test.ts` files tagged with the new tag.
2. Add the tag value to `tests/tags.ts` if not already declared. `vitest.config.ts` picks it up from there automatically.
3. Optionally bump the `TOOL_GROUPS` default in `service.yml`'s `run-integration-tests` and `scheduled-run-integration-tests` tasks (or just override per-run in the Semaphore UI).

No matrix or block changes needed — the new tag joins the existing matrix axis.

## What NOT to Do

- **Don't reuse `tests/server.ts`** — that's `createTestServer()` with
  `InMemoryTransport`, for protocol-level unit tests. Integration tests need
  real transport wiring.
- **Don't require `CONFLUENT_CLOUD_*` for Kafka admin tests** — those handlers
  don't touch the control plane. Only gate on what the handler actually uses.
- **Don't set `MCP_API_KEY`** — the HTTP and SSE transports both run with
  `MCP_AUTH_DISABLED=true`.
- **Don't use `vi.mock` or stubs** — integration tests exercise real code
  paths end-to-end. If you find yourself wanting to fake something, the test
  probably belongs in a colocated `*.test.ts` unit test instead.
- **Don't call `process.exit`, `setTimeout` for waiting, or other raw
  lifecycle primitives in tests** — always go through the harness.
- **Don't log credentials, env vars, or config objects** — integration test
  stderr/stdout gets captured into junit XML and published to Semaphore. Log
  specific fields (URLs, status codes, IDs) rather than whole object bindings,
  and never pass `process.env` or a full config object to a logger or
  `console.*` call.
