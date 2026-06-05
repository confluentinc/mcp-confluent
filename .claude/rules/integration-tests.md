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
- Tag the outermost `describe` with **two** axes via the `Tag` enum from `@tests/tags.js`: the tool-group tag (e.g. `Tag.KAFKA`) and at least one service-config tag (e.g. `Tag.REQUIRES_KAFKA_CONFIG`).
  Tool-group tags map 1:1 to handler directories under `src/confluent/tools/handlers/` and drive per-PR `change_in()` gating in `.semaphore/semaphore.yml`.
  Service-config tags map 1:1 to service blocks on `MCPServerConfiguration` (`kafka`, `flink`, `schema_registry`, `confluent_cloud`, `tableflow`, `telemetry`) and drive the matrix axes in `.semaphore/integration.yml`.
  A test that needs more than one service block to be provisioned declares all of them and will run in every matching block of the scheduled / manual pipeline.
  `tests/tags.ts` is the single source of truth; `vitest.config.ts` derives its `test.tags` list from the same enum, so adding a new tag means editing one file.

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
2. For HTTP and SSE, writes `server.auth.disabled = true` into the
   per-spawn YAML config (via `spawnConfigPath` in
   `tests/harness/runtime.ts`). Tests run on 127.0.0.1 with DNS rebinding
   protection still active, so skipping the API-key middleware is safe and
   means you don't need any auth secrets in `.env.integration`. Both
   transports share the same Fastify auth hook, so one YAML field covers
   them. The auth smoke test opts back in via
   `startServer({ auth: { apiKey } })`, which writes `server.auth.api_key`
   and propagates the matching `cflt-mcp-api-key` header to the SDK
   transport.
3. For HTTP and SSE, calls `findFreePort()` to allocate a fresh TCP port per
   test file. Tests can run in parallel even if `npm run start:http` is
   already bound to 8080 locally.

Always call `stop()` in `afterAll` to tear down the child process. The harness
awaits the child's exit event symmetrically for both transports.

### Auth-enabled spawns

HTTP and SSE spawns default to `server.auth.disabled = true`; routine tests
don't need any auth secrets. To exercise the API-key middleware end-to-end,
opt in via `startServer({ auth: { apiKey } })`. The harness then:

- writes `server.auth.api_key` and forces `server.auth.disabled = false`
  into the per-spawn YAML (the Zod schema rejects both being set);
- propagates the matching `cflt-mcp-api-key` header through both the SDK
  client transport AND the `/ping` readiness probe (the auth hook is
  `onRequest`-scoped, so `/ping` is gated too);
- exposes `StartedServer.baseUrl` (HTTP/SSE only) for raw-fetch negative
  paths that bypass the SDK client.

The header name is exported as `CFLT_MCP_API_KEY_HEADER` from
`@src/mcp/transports/auth.js`. See
`src/mcp/transports/auth.integration.test.ts` for the canonical
no-header / wrong-header / correct-header pattern.

## Canonical Test Structure

```ts
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { integrationConnection } from "@tests/harness/runtime.js";
import { skipIfDisabled } from "@tests/harness/skip-gate.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListTopicsHandler();

describe("my-handler", { tags: [Tag.KAFKA] }, () => {
  // early-return short-circuits the describe body when creds are absent.
  // see "Skip Pattern" below for why this isn't `describe.skipIf`.
  if (skipIfDisabled(handler, integrationConnection())) {
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

**Verify response shape before writing a parser.** Handlers often
re-stringify external API payloads verbatim, and the on-the-wire shape can
differ from what the handler's source suggests. When a test needs to parse
text content into structured data, run the tool once with
`console.error(textContent(result))` to capture the actual shape, then write
the parser against that. Remove the diagnostic before commit. (E.g.
`list-flink-databases` emits Flink SQL row payloads of shape
`{ row: [...] }`, not column-named objects.)

### When to assert `isError` explicitly

**Skip the explicit `isError` check by default.** When the next assertion is
`expect(textContent(result)).toMatch/toContain/toBe(...)`, the matcher's
failure output already shows `received: "<actual error text>"`, because
errors and successes share the same text content block
(`BaseToolHandler.createResponse(msg, true)` puts the error message in
`content[0].text`). A separate `expect(result.isError).not.toBe(true)` line
adds noise without surfacing anything new.

Reach for an explicit check only when the next assertion would shadow or
destroy the error text:

- The next assertion polls a separate resource (e.g.
  `expect.poll(() => admin.listTopics()).toContain(topic)`). The handler's
  error never reaches that matcher, so a failed call silently times out.
- The next step parses the response (e.g.
  `JSON.parse(textContent(result))`). A non-JSON error body throws a cryptic
  `SyntaxError` with no original message.

For those cases, use vitest's inline `expect(value, message)` form so the
error text rides along with the failure (no helper needed):

```ts
expect(result.isError, textContent(result)).not.toBe(true);
```

## Skip Pattern for Missing Credentials

Do **NOT** use `describe.skipIf(!hasCreds)`. In vitest 4 it marks tests as
skipped but still synchronously executes the describe body, which means
nested `describe.each` hooks register and their `beforeAll`s run, and the
harness's server spawn then hits the hook timeout.

Use the early-return pattern shown above: a plain `if (!hasCreds) { it.skip(reason); return; }` at the top of the describe body. The placeholder
`it.skip()` keeps the file visible in vitest reports with a clear reason line.

### Runtime preconditions vs file-load gates

The skip above runs at file-load time against the parsed YAML. Some
preconditions can only be evaluated _after_ the MCP server starts (e.g.,
"the configured kafka cluster is catalogued in the Flink workspace" requires
calling a tool to find out). Two options for those:

- **Assertion (preferred when the precondition is supposed to hold).** Inline
  `expect(value, "<actionable message>").toBeDefined()` (or
  `.not.toBe(true)`, etc.) so a CI failure points at the env regression that
  needs fixing. The custom message is the second arg to `expect`, not the
  matcher.
- **`ctx.skip(reason)` (only when the precondition genuinely may not hold).**
  In vitest 4, `it("...", async (ctx) => { if (...) ctx.skip(...); ... })`
  is the canonical mid-test skip. Use this only when "skipped" is a
  legitimate outcome, not as a way to swallow a real failure. Silent green
  on a broken env is exactly the failure mode this project warns against.

When in doubt, prefer the assertion: an actionable failure message that
names what to fix is more valuable than a green test run that hides the
problem.

## Credential Gating by Tool Domain

Tests gate via the `skipIfDisabled` helper, which runs the handler's predicate against the single integration-fixture connection.
This is the same predicate the server uses in `getToolHandlersToRegister()` to decide whether to register the tool, so if the server can register it the test runs; if not, the helper calls `it.skip` and returns `true` so the describe body bails.
The skip reason defaults to the verdict's `ToolDisabledReason`, so the message names the missing config without a hand-typed string.

```ts
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import { integrationConnection } from "@tests/harness/runtime.js";
import { skipIfDisabled } from "@tests/harness/skip-gate.js";

const handler = new ListTopicsHandler();

if (skipIfDisabled(handler, integrationConnection())) {
  return;
}
```

`integrationConnection()` (in `@tests/harness/runtime.js`) returns the sole connection from `test-fixtures/yaml_configs/integration.yaml` (the same fixture the harness rewrites for each spawn), loaded via {@linkcode loadConfigFromYaml}.
Integration fixtures hold exactly one connection, so a single connection is the right-sized input for a predicate — no `ServerRuntime` to build.
Pass `{ oauth: true }` for the OAuth fixture (`integration-oauth.yaml`).
On load failure it returns an empty `direct` connection, so the predicate yields a clean disabled verdict whose reason names the missing config.
Confluent Platform tests use the peer `cpIntegrationConnection()` from `@tests/harness/cp-runtime.js`, which reads `integration.cp.yaml`.

The fixture is validated by the Zod schema in `src/config/models.ts`
(`MCPServerConfiguration`). Adding a new service block to the YAML without
a matching schema entry throws at load time with a Zod path pointing at the
offending key — surface that error there rather than chasing a downstream
predicate failure.

The predicates referenced below live in
`src/confluent/tools/connection-predicates.ts`. Pick the one matching the
handler's predicate; if none fit, add a new predicate there first.

The skip reason comes from the predicate's `ToolDisabledReason`, so you no longer hand-type or maintain per-test label strings — the per-test labels #288 anticipated collapsing are gone, sourced from the one enum the predicates already carry.
Reference the right predicate on the handler and the verdict carries the user-facing phrasing; the REST-proxy tests (`get-topic-config`, `alter-topic-config`) still call `getTestClusterId()` from `@tests/harness/kafka-admin.js` to address the cluster, which throws if `kafka.cluster_id` is missing from the fixture.

A few gates need an explicit reason the generic verdict can't express, and pass it as `skipIfDisabled`'s `reasonOverride` (third arg):
the OAuth-fixture and OAuth-seeding gates pass `OAUTH_FIXTURE_NOT_LOADED_REASON` / `DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON`;
the Confluent Platform gates pass their docker-compose + `CP_KAFKA_*` setup-runbook string.
The transport smoke tests don't gate on a handler predicate at all — they ask "did any connection load?" via `integrationConnectionLoaded()`.

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
`uniqueName(slug)` helper in `@tests/harness/unique-name.js`. The `int-`
prefix marks resources as test-created so orphan cleanup of leaked state
can identify them by name. The helper is resource-agnostic: kafka topics,
schema-registry subjects, and any future test-side resource share the
same generator so naming stays consistent across tool groups.

```ts
import { withSharedAdminClient } from "@tests/harness/kafka-admin.js";
import { uniqueName } from "@tests/harness/unique-name.js";

// in the describe body, after the predicate gate:
const { admin, createdTopics } = withSharedAdminClient();

// in an `it` block:
const topic = uniqueName("create"); // e.g. "int-create-1729123456789-a7f3b2"
createdTopics.push(topic);
await admin().createTopics({ topics: [{ topic, numPartitions: 1 }] });
```

`withSharedAdminClient()` registers `beforeAll`/`afterAll` at the calling describe
scope — connecting one admin client up front, deleting any tracked topics
after the suite, and disconnecting. Tests push names onto `createdTopics`
as they create them. The `admin` getter is a function because the
underlying client is only assigned inside `beforeAll`, so a direct value
captured at describe-body evaluation would be `undefined` when test bodies
run.

Call `withSharedAdminClient()` at the **outer** describe level (before
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

## Connection-Type Filtering

`activeConnectionTypes` (from `@tests/harness/connection-types.js`) mirrors `activeTransports` along a second axis: dual-mode tests use it to gate the connection shapes (direct vs OAuth) they support.
It honors the `INTEGRATION_TEST_CONNECTION_TYPE` env var:

- **unset** or **`all`** → both connection types active (default for local runs / full coverage)
- **`direct`** or **`oauth`** → only that connection type active

`all` is an explicit sentinel because the Semaphore Tasks UI serializes an empty-string dropdown option as the literal 2-char string `""`, which would slip past a plain emptiness check.
The Makefile mirrors this on the tag-filter side: unset or `all` appends no clause, `oauth` appends `&& @oauth` (only OAuth describes collect), `direct` appends `&& !@oauth` so the direct-only lane doesn't double-execute direct-only tests through OAuth describes.

Single-mode tests (the vast majority; everything that needs only direct api-key auth) don't need to touch this; they default to direct via the `integrationConnection()` / `startServer({ transport })` calls.

Dual-mode tests nest **one outer `describe` per handler with two inner connection-specific describes** (one per `ConnectionType` enum value, titled via template strings like `` `with a ${ConnectionType.DIRECT} connection` `` so the title stays in sync if the enum changes).
Each inner describe is linear (no `isOAuth` branching inside) and gates itself via three early-return skip checks in cost order: connection-type filter, predicate gate, OAuth creds (OAuth describe only).
The connection is loaded **after** the filter gate so a CI run that excludes one mode never parses that mode's YAML.

```ts
describe("<handler>", { tags: [Tag.<GROUP>] }, () => {
  describe(`with a ${ConnectionType.DIRECT} connection`, () => {
    if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
      it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
      return;
    }
    if (skipIfDisabled(handler, integrationConnection())) {
      return;
    }

    describe.each(activeTransports)("via %s transport", (transport) => {
      // direct-only beforeAll (startServer) / afterAll (server.stop()) + tests
    });
  });

  describe(`with a ${ConnectionType.OAUTH} connection`, { tags: [Tag.OAUTH] }, () => {
    if (!activeConnectionTypes.includes(ConnectionType.OAUTH)) {
      it.skip(CONNECTION_TYPE_OAUTH_FILTERED_REASON, () => {});
      return;
    }
    if (
      skipIfDisabled(
        handler,
        integrationConnection({ oauth: true }),
        OAUTH_FIXTURE_NOT_LOADED_REASON,
      )
    ) {
      return;
    }
    const credentials = getOAuthCredentialsFromEnv();
    if (!credentials) {
      it.skip(OAUTH_USER_CREDS_MISSING_REASON, () => {});
      return;
    }

    describe.each(activeTransports)("via %s transport", (transport) => {
      // oauth-only beforeAll (startOAuthServer + 180_000 timeout) / afterAll (stopOAuthServer)
      // tool calls dispatch via callToolWithOAuthFlow(server, credentials, ...)
    });
  });
});
```

Tags are **additive down the describe tree**: the outer describe carries the group tag (`Tag.<GROUP>`), the inner `oauth` describe adds `Tag.OAUTH`, the inner `direct` describe adds nothing.
A test inside `direct` therefore runs under `[Tag.<GROUP>]`; a test inside `oauth` runs under `[Tag.<GROUP>, Tag.OAUTH]`.
This matches the project's asymmetric `Tag.OAUTH` rule (direct is the unmarked baseline; OAuth is the marked deviation) without per-describe tag duplication.

Skip-gate constants used above live with the harness module they belong to:

- `CONNECTION_TYPE_DIRECT_FILTERED_REASON` and `CONNECTION_TYPE_OAUTH_FILTERED_REASON` from `@tests/harness/connection-types.js` (the filter gate is the same in every dual-mode test, so the strings are exported rather than re-typed per file).
- `OAUTH_FIXTURE_NOT_LOADED_REASON` and `OAUTH_USER_CREDS_MISSING_REASON` from `@tests/harness/oauth-flow.js` (used only by the OAuth describe).

The gate ORDER (filter → runtime → predicate → creds) is intentional: cheapest gate first.
A run that filters out one connection type short-circuits the unwanted describe at the array-includes check without ever loading the other fixture or reading the env for creds.

Why nested describes rather than one `for...of` loop or two top-level siblings?
A loop body has to thread an `isOAuth` ternary through every site that differs between modes (server start, teardown, tags array, tool-call dispatch, predicate skip reason).
Nesting under a single outer describe makes each inner body linear, lets the outer describe carry the group tag once (no duplication), and turns the "extend an existing direct-only test to OAuth" story into a pure addition: the direct describe stays byte-identical, and the OAuth describe gets appended as a sibling.

See `src/confluent/tools/handlers/organizations/list-organizations-handler.integration.test.ts` for the canonical worked example.

### `Tag.OAUTH` semantics (asymmetric on purpose)

`Tag.OAUTH` marks the inner `oauth` describe of a dual-mode test (and any single-mode test that exercises the CCloud OAuth flow).
There is **no** `Tag.DIRECT`: direct is the unmarked majority, and CI lanes that want only direct tests use `!@oauth` exclusion rather than positive `@direct` selection.
This means new direct-only tests don't need to remember to tag themselves; "not tagged with @oauth" reliably catches every direct test by construction.

### OAuth-required optional arguments

Some `.optional()` tool args become **required at call time under OAuth** because OAuth connections carry no service blocks for the handler to fall back on.
Omit them and the handler errors with `<arg> is required under OAuth ...`.
Pass YAML-pinned helpers in the OAuth describe's `callToolWithOAuthFlow` arguments; leave the direct describe alone.
Known cases:

- **Schema Registry tools** (`list-schemas`, `delete-schema`): `environment_id` from `getTestEnvironmentId()` — direct gets it from the `schema_registry` block.
- **Native-Kafka tools** (every `kafkaBootstrapOrOAuth` handler — `list-topics`, `create-topics`, `delete-topics`, `produce-kafka-message`, `consume-kafka-messages`, `list-consumer-groups`, `get-partition-offsets`, `describe-consumer-group`, `get-consumer-group-lag`): **both** `cluster_id` (from `getTestClusterId()`) **and** `environment_id` (from `getTestEnvironmentId()`) — direct gets them from the `kafka` block.
- **Kafka REST-proxy tools** (`kafkaRestWithAuthOrOAuth` — `get-topic-config`, `alter-topic-config`): `clusterId` + `environmentId` in **camelCase** (handler-side convention), built from the same two helpers. Direct already passes `clusterId`; OAuth additionally requires `environmentId`.

Spot these in advance by scanning the handler's Zod schema for `.optional()` args whose `.describe()` text mentions OAuth, environment, or cluster, and by reading the resolver the handler calls at entry (`resolveKafkaClusterArgs`, `resolveKafkaRestArgs`, `resolveEnvArg`) — the resolver's OAuth branch documents exactly which args are required.

### Direct-fixture gate for OAuth describes that seed

OAuth describes that need test-side seeding (admin client, SR client, env-id lookup) route through api-key-authed helpers that read the direct fixture — so an OAuth-only CI run with no direct creds crashes inside `beforeAll`.
Gate after the OAuth credential check:

```ts
if (
  skipIfDisabled(
    handler,
    integrationConnection(),
    DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON,
  )
) {
  return;
}
```

Reuses the handler's own `widenForOAuth(...)` predicate against the direct connection — strips the OAuth special case, falls back to the direct check the seeding helper needs.
The `reasonOverride` keeps the explicit `DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON` (not the verdict reason), since it names a seeding precondition the generic verdict can't express.
OAuth describes that don't seed (e.g. `list-organizations`, `list-billing-costs`) skip this gate.

## CI Matrix

The CI surface has two shapes; they share the harness and the Makefile but differ in what each block represents.

### Per-PR (`.semaphore/semaphore.yml`)

One block per tool group (12 of them) plus a smoke block, each gated by `run.when: change_in('/src/confluent/tools/handlers/<dir>/', { default_branch: 'main' })`.
Only the blocks whose handler dirs the PR touched actually run; everything else stays gray.
Within a block, a single job exercises both connection types sequentially via the harness's `activeConnectionTypes` default; transport (stdio/http/sse) and connection type (direct/oauth) are deliberately NOT Semaphore axes, since splitting them would multiply agent count without unique coverage.
The smoke block fires on any change under `src/` (excluding `*.test.ts`) so transport-layer regressions (auth middleware, multi-client wiring, OAuth flow) trigger regardless of which handler dir the PR touched.

### Scheduled / manual full (`.semaphore/integration.yml`)

One block per service config (6 of them: kafka, schema-registry, confluent-cloud, flink, tableflow, telemetry) plus a cross-cutting `@smoke` block that runs the transport-layer regression tests (auth middleware, multi-client wiring, OAuth round-trip).
Each service-config block declares a hard-coded `TOOL_GROUP` matrix of the tool groups whose handlers consume that service config; a tool group with handlers across multiple service configs appears in each matching block (e.g. `@catalog` runs under both `@requires-kafka-config` and `@requires-confluent-cloud-config`).
The smoke block has no matrix axis and no service-config filter; it just runs `make test-integration TAGS=@smoke`.
The scheduled task in `service.yml` and the manual `Integration Tests: full (manual)` promotion in `semaphore.yml` both pass two parameters to this pipeline: `SERVICE_CONFIGS` (pipe-separated, controls which blocks run via each block's `skip.when` clause; accepts the six service-config tags plus `@smoke` as a sentinel for the cross-cutting block) and `CONNECTION_TYPE` (one of `all` / `direct` / `oauth`, forwarded as `INTEGRATION_TEST_CONNECTION_TYPE` to both the harness's `activeConnectionTypes` filter and the Makefile's tag-filter composer).

### Tuning CI speed without code changes

| Want to ...                                                   | Edit                                                                                       | Effect                                             |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Drop a block (service config or smoke) from the scheduled run | `SERVICE_CONFIGS` default in `service.yml`                                                 | Skips one whole block in the scheduled pipeline    |
| Limit a manual run to one connection mode                     | Pick `direct` or `oauth` for `CONNECTION_TYPE` in the Semaphore UI                         | Halves runtime per cell                            |
| Stop a tool group from running on PRs                         | Delete the corresponding block in `.semaphore/semaphore.yml`                               | One fewer block; rest stays `change_in()`-gated    |
| Re-balance which scheduled block runs a tool group            | `TOOL_GROUP` matrix `values` array in `.semaphore/integration.yml`                         | Moves the cell to a different service-config block |
| Tighten the per-PR smoke-block trigger                        | The `exclude` glob in the smoke block's `change_in()` clause in `.semaphore/semaphore.yml` | Reduces smoke-block fire rate on PRs               |
| Change how the daily run is scheduled                         | The `at:` cron in `service.yml`'s `scheduled-integration-tests` task                       | Shifts daily run time                              |

Anything beyond this (adding a new tag axis, renaming a tag, adding a new service-config block to `MCPServerConfiguration`) is a tag-system structural change and requires touching `tests/tags.ts`, the integration test files, and the harness alongside the YAML.

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

6. **CI wiring**:
   - Add a new tool-group block to `.semaphore/semaphore.yml` (copy an existing block, swap the name, the `change_in()` handler dir, and the `TAGS=` value in the job command).
   - Add the new tool-group tag to the `TOOL_GROUP` matrix `values` array in every `.semaphore/integration.yml` service-config block whose service config the new handler consumes.
   - Service-config blocks in `integration.yml` and the `SERVICE_CONFIGS` default in `service.yml`'s `scheduled-integration-tests` task only need to change if the new handler also requires a new service config (i.e. a new `REQUIRES_*_CONFIG` tag).

## What NOT to Do

- **Don't reuse `tests/server.ts`**: that's `createTestServer()` with
  `InMemoryTransport`, for protocol-level unit tests. Integration tests need
  real transport wiring.
- **Don't require `CONFLUENT_CLOUD_*` for Kafka admin tests**: those handlers
  don't touch the control plane. Only gate on what the handler actually uses.
- **Don't set auth env vars in `.env.integration`**: routine integration
  tests spawn with `server.auth.disabled = true` in the per-spawn YAML, so
  the API-key middleware isn't exercised. The auth smoke test opts in via
  the harness's `auth: { apiKey }` option (see `auth.integration.test.ts`
  for the pattern).
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
- **Don't build a `Client<paths>` without installing the 429-retry middleware**:
  every test-side openapi-fetch `Client<paths>` (whether in a test file or
  inside a harness helper) must call
  `client.use(createRetryOn429Middleware())` (from
  `@tests/harness/retry-on-429.js`) before being used. The existing factories
  under `tests/harness/` already do this; reuse them, or use the higher-level
  helpers built on top of them, instead of calling `createClient` directly.
  A new harness helper on a different host or with different creds must
  mirror the same `client.use(...)` line. A client built without the
  middleware silently bypasses retry coverage; full-suite runs already push
  CCloud's per-account quota close to its limit, and provision/teardown
  traffic compounds across files × transports × the matrix.
