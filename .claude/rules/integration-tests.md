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
- Do NOT put integration test files under `tests/` (only shared harness,
  stubs, factories, and fixtures live there).
- Tag the outermost `describe` with the tool group via the `Tag` enum from
  `@tests/tags.js` (e.g. `{ tags: [Tag.KAFKA] }`). `tests/tags.ts` is the
  single source of truth; `vitest.config.ts` derives its `test.tags` list
  from the same enum, so adding a new tool group means editing one file.

## Running Tests Locally

- `npm run test` - full sweep: builds `dist/` then runs both unit and
  integration projects.
- `npm run test:unit` - unit tests only (fast, no build).
- `npm run test:integration` - integration tests only (builds `dist/` then
  runs `--project integration`).
- `npm run test:integration -- --tags-filter=@kafka` - one tool group at a time.

Set up local creds by copying `.env.integration.example` to `.env.integration`
and filling in the vars your chosen tests need. `tests/harness/setup.ts` loads
that file automatically via dotenv.

## Vitest Project Config (`vitest.config.ts`)

The `integration` project differs from `unit` in a few specific ways. If you
find yourself reaching for any of these per-test, consider whether the
project-level setting should change instead:

- `testTimeout: 60_000`, `hookTimeout: 60_000` - server spawn + cold CCloud
  round-trips blow past the 10s unit default.
- `pool: "forks"` - one worker per test file so each file spawns its own MCP
  server and binds its own HTTP port without collisions.
- `setupFiles: ["tests/harness/setup.ts"]` - loads `.env.integration` via
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
   imported by unit tests; without the override, vitest's default
   `NODE_ENV=test` would cause the child to exit without starting the server.
2. For HTTP and SSE, sets `MCP_AUTH_DISABLED=true`. Tests run on 127.0.0.1
   with DNS rebinding protection still active, so skipping the API-key header
   exchange is safe and means you don't need `MCP_API_KEY` in
   `.env.integration`. Both transports share the same Fastify auth hook, so
   the same flag covers them.
3. For HTTP and SSE, calls `findFreePort()` to allocate a fresh TCP port per
   test file. Tests can run in parallel even if `npm run start:http` is
   already bound to 8080 locally.

Always call `stop()` in `afterAll` to tear down the child process. The harness
awaits the child's exit event symmetrically for both transports.

## Canonical Test Structure

```ts
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListTopicsHandler();
const runtime = integrationRuntime();

describe("my-handler", { tags: [Tag.KAFKA] }, () => {
  // early-return short-circuits the describe body when creds are absent.
  // see "Skip Pattern" below for why this isn't `describe.skipIf`.
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires kafka.bootstrap_servers config", () => {});
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
nested `describe.each` hooks register and their `beforeAll`s run, and the
harness's server spawn then hits the hook timeout.

Use the early-return pattern shown above: a plain `if (!hasCreds) { it.skip(reason); return; }` at the top of the describe body. The placeholder
`it.skip()` keeps the file visible in vitest reports with a clear reason line.

## Credential Gating by Tool Domain

Tests use `handler.enabledConnectionIds(runtime).length === 0` as the gate
(the same predicate the server uses in `getToolHandlersToRegister()` to
decide whether to register the tool). If the server can register it, the
test runs; if not, the test skips.

```ts
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import { integrationRuntime } from "@tests/harness/runtime.js";

const handler = new ListTopicsHandler();
const runtime = integrationRuntime();

if (handler.enabledConnectionIds(runtime).length === 0) {
  it.skip("requires kafka.bootstrap_servers config", () => {});
  return;
}
```

`integrationRuntime()` (in `@tests/harness/runtime.js`) builds the same
`ServerRuntime` the spawned server would build, by calling
{@linkcode loadConfigFromYaml} against
`test-fixtures/yaml_configs/integration.yaml` (the same fixture the
harness rewrites for each spawn). Both paths share that loader, so the
test's view of "configured" matches the server's by construction.

The fixture is validated by the Zod schema in `src/config/models.ts`
(`MCPServerConfiguration`). Adding a new service block to the YAML without
a matching schema entry throws at load time with a Zod path pointing at the
offending key — surface that error there rather than chasing a downstream
predicate failure.

The predicates referenced below live in
`src/confluent/tools/connection-predicates.ts`. Pick the one matching the
handler's predicate; if none fit, add a new predicate there first.

The skip-reason string is a hand-typed dotted-path label that names the
YAML config block(s) the handler's predicate inspects. Picking the right
label per test:

- Handlers gating on `hasKafkaBootstrap` (direct Kafka: `list-topics`,
  `create-topics`, `delete-topics`, `produce-message`, `consume-messages`):
  `"requires kafka.bootstrap_servers config"`.
- Handlers gating on `hasKafkaRestWithAuth` (REST proxy: `get-topic-config`,
  `alter-topic-config`): `"requires kafka.rest_endpoint + kafka.auth config"`.
  These tests also call `testClusterId()` from `@tests/harness/kafka-admin.js`
  to address the cluster — the helper throws (vs. silently returning
  `undefined`) if `kafka.cluster_id` is missing from the fixture.
- Other tool groups (e.g. `@schema`, `@flink`) follow the same shape:
  pick the dotted YAML key(s) that the handler's predicate touches.

A future cleanup will derive these strings from the handler's predicate
automatically (see #288 and #289); for now, keep them in sync by hand.

### Auth gap for direct-Kafka handlers (deliberate)

`hasKafkaBootstrap` (used by `list-topics`, `create-topics`, `delete-topics`,
`produce-message`, `consume-messages`) only checks
`kafka.bootstrap_servers`, not auth (handlers support unauthenticated
local Kafka). A YAML fixture with `bootstrap_servers` set but no `auth` will
pass the gate, then fail at runtime when CCloud rejects the SASL_SSL
handshake. This is intentional: a real auth error is louder and more
actionable than a silent skip.

The 2 REST-proxy tools (`get-topic-config`, `alter-topic-config`) use
`hasKafkaRestWithAuth`, which checks both `rest_endpoint` AND `auth`, so
they fail-closed without it.

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
  uniqueTopicName,
  withSharedAdmin,
} from "@tests/harness/kafka-admin.js";

// in the describe body, after the predicate gate:
const { admin, createdTopics } = withSharedAdmin();

// in an `it` block:
const topic = uniqueTopicName("create"); // e.g. "int-create-1729123456789-a7f3b2"
createdTopics.push(topic);
await admin().createTopics({ topics: [{ topic, numPartitions: 1 }] });
```

`withSharedAdmin()` registers `beforeAll`/`afterAll` at the calling describe
scope — connecting one admin client up front, deleting any tracked topics
after the suite, and disconnecting. Tests push names onto `createdTopics`
as they create them. The `admin` getter is a function because the
underlying client is only assigned inside `beforeAll`, so a direct value
captured at describe-body evaluation would be `undefined` when test bodies
run.

Call `withSharedAdmin()` at the **outer** describe level (before
`describe.each`) so all transport iterations share one admin connection
(fewer CCloud round trips).

### Verifying state on a separate admin client

CCloud propagates Kafka metadata asynchronously. A test-side admin client's
`listTopics()` right after a handler's CREATE_TOPICS / DELETE_TOPICS call can
lag the broker by a few seconds, because the handler's admin and the test's
admin have separate metadata caches. Use `expect.poll` instead of a single
snapshot. It retries the value-fetcher until the matcher passes or the
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
tool groups (the `TOOL_GROUP` matrix axis). The matrix axis picks up new
tags automatically — no block or anchor changes needed.

## Adding a New Tool Group

To add `*.integration.test.ts` coverage for a new Confluent service (e.g.,
Schema Registry, Flink, Tableflow):

1. **Tag enum**: add an entry to the `Tag` enum in `tests/tags.ts`.
   `vitest.config.ts` derives its `test.tags` list from this enum, so no
   other config updates are needed.

2. **YAML fixture**: add the service block (e.g., `schema_registry:`,
   `flink:`) to `test-fixtures/yaml_configs/integration.yaml` under a
   `# --- @<tag> ---` marker matching the `kafka:` block's pattern. The Zod
   schema in `src/config/models.ts` (`MCPServerConfiguration`) must accept
   the keys you add — if it doesn't, the fixture throws at load time with
   a Zod path that points at the offending key.

3. **Secret slots**: add the corresponding secret env vars to
   `.env.integration.example` under a `# --- @<tag> ---` section. Reference
   them in the YAML via `${VAR}` interpolation; non-secret config (cluster
   IDs, endpoints, region names, etc.) stays as YAML literals.

4. **Vault fields** (if Vault-backed): add the field names to
   `VAULT_PATH_FIELDS` in the `Makefile` so `make setup-test-env` populates
   them from the team's Vault path.

5. **Tests**: add `*.integration.test.ts` files colocated with handlers,
   tagged with the new `Tag` value. Pick a connection predicate from
   `src/confluent/tools/connection-predicates.ts` for the skip gate (or
   add a new predicate there if none fit).

6. **CI default** (optional): bump the `TOOL_GROUPS` default in
   `service.yml`'s `scheduled-integration-tests` task to include the new
   tag, or override per-run via the Semaphore UI.

## What NOT to Do

- **Don't reuse `tests/server.ts`**: that's `createTestServer()` with
  `InMemoryTransport`, for protocol-level unit tests. Integration tests need
  real transport wiring.
- **Don't require `CONFLUENT_CLOUD_*` for Kafka admin tests**: those handlers
  don't touch the control plane. Only gate on what the handler actually uses.
- **Don't set `MCP_API_KEY`**: the HTTP and SSE transports both run with
  `MCP_AUTH_DISABLED=true`.
- **Don't use `vi.mock` or stubs**: integration tests exercise real code
  paths end-to-end. If you find yourself wanting to fake something, the test
  probably belongs in a colocated `*.test.ts` unit test instead.
- **Don't call `process.exit`, `setTimeout` for waiting, or other raw
  lifecycle primitives in tests**: always go through the harness.
- **Don't log credentials, env vars, or config objects**: integration test
  stderr/stdout gets captured into junit XML and published to Semaphore. Log
  specific fields (URLs, status codes, IDs) rather than whole object bindings,
  and never pass `process.env` or a full config object to a logger or
  `console.*` call.
