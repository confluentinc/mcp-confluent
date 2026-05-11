---
paths:
  - src/**/*.test.ts
  - tests/**/*
---

# Unit Testing (Vitest)

## Framework & Location

- Co-located `.test.ts` files alongside source code using Vitest
- Run with `npm run test:unit` (single run) or `npm run test:unit:watch` (watch mode). `npm run test` runs both unit and integration; reach for it only when you want the full sweep.
- Config in `vitest.config.ts`; `@src/*` aliases resolved via `resolve.tsconfigPaths`
- `restoreMocks: true` is set project-wide, so every `vi.spyOn` call is automatically restored
  after each test - no per-test restore hooks needed

## Test Naming

- Use the "should ..." convention: `it("should return a list of topics", ...)`
- Group related tests with `describe` blocks named after the unit under test

## Assertions

- Use Vitest `expect(...)` for everything — values, thrown errors, and mock call verification
- Common mock assertions:
  - `expect(mock).toHaveBeenCalledOnce()`
  - `expect(mock).toHaveBeenCalledWith(arg)`
  - `expect(mock).toHaveBeenCalledTimes(n)`
  - `expect(mock).not.toHaveBeenCalled()`

### Literal arguments over loose matchers (default)

When the test owns the inputs to the unit under test, assert the resulting call with
**literal deep-equality**, not partial matchers. `toHaveBeenCalledWith` uses `toEqual`
semantics, so a literal object pins the exact contract and produces precise diffs on
drift. Vitest treats `{ k: undefined }` and `{}` as equal, so an explicit `undefined`
in the expected literal stays robust whether the call site passes the key or omits
it.

```typescript
// Prefer: literal pins the contract — extra keys, renamed keys, regressed shapes all fail loudly.
expect(client.GET).toHaveBeenCalledWith("/tableflow/v1/regions", {
  params: {
    query: { cloud: "AWS", page_size: undefined, page_token: undefined },
  },
});

// Avoid: lets a buggy call shape slip through silently.
expect(client.GET).toHaveBeenCalledWith(
  expect.any(String),
  expect.objectContaining({
    params: expect.objectContaining({
      query: expect.objectContaining({ cloud: "AWS" }),
    }),
  }),
);
```

Reach for `expect.any(...)`, `expect.objectContaining(...)`, `expect.stringContaining(...)`,
or `expect.anything()` only when there is **genuine non-determinism** the test can't
compute — timestamps, generated UUIDs, opaque tokens minted by the unit under test, or
fields whose value the test deliberately doesn't pin (e.g. a free-port-allocated URL).
"I don't want to spell out the full object" is not non-determinism.

**Cautionary tale.** Issue #129 (`ListTableFlowRegions sends cloud=undefined`) was a path
key built via template literal — the colocated test used `expect.any(String)` for that
path and `expect.objectContaining({ params: { path: { cloud: "AWS" } } })` for the
options. The matchers were internally consistent with the broken implementation, so the
test passed even though the call sent `/tableflow/v1/regions?cloud=undefined` to CCloud.
A literal assertion on the path string and the options object would have failed against
the buggy code and prevented the bug from shipping. The loose matcher and the bug were
two sides of the same coin.

## Key Patterns

- Use `createMockInstance(DirectClientManager)` (from `@tests/stubs/index.js`) for handler tests
  with one class dependency. The returned object is typed as `Mocked<DirectClientManager>` so
  method-chain autocomplete works (`.mockResolvedValue`, etc.)
- Don't wrap simple one-liners in helper functions
- Use `createTestServer()` from `@tests/server` for integration-style tests that need a full MCP
  server + client connected via `InMemoryTransport`
- Focus on isolated behavior, mocking external dependencies
- Do not test or stub side effects like logging — no logger stubs or assertions needed
- Only stub what affects behavior — pure-value functions like `os.platform()` don't need stubbing
  when `expect.any(String)` suffices for assertions
- Access private/protected members via bracket notation in tests: `obj["privateProp"]`
- Set up common stubs in the top-level `describe` block so they apply to all tests

## Design for Stubbing

`vi.spyOn` mutates a property on a supplied object. It cannot retroactively intercept an ESM
named import that another module already resolved: module namespaces are read-only from outside
the defining module per the ECMAScript spec. This is a language-level constraint, not a Vitest
limitation (Sinon had the same constraint).

**Solutions** (all of which make the dependency reachable via property lookup at call time):

- Extract dependencies to separate modules and export them as properties of a namespace object
- Pass dependencies as parameters
- Use namespace objects (see `node-deps.ts`) so callers access via property lookup instead of a
  bare named import

### ESM Live Bindings and `node-deps.ts`

`@src/confluent/node-deps.js` re-exports Node builtins and third-party constructors as plain
objects whose properties Vitest can spy on:

```typescript
// source file
import { fs, os, segment } from "@src/confluent/node-deps.js";
fs.readFileSync(path); // node builtins
new segment.Analytics({ key }); // third-party constructors

// test file
import * as nodeDeps from "@src/confluent/node-deps.js";
vi.spyOn(nodeDeps.fs, "readFileSync").mockReturnValue("content");
vi.spyOn(nodeDeps.segment, "Analytics").mockImplementation(function () {
  return { track: trackStub };
} as any);
```

The env proxy is intentionally **not** wrapped in `node-deps.ts`. Production code receives an
already-validated `Environment` as an explicit parameter from the bootstrap; it doesn't reach
into a global. Tests therefore don't need to stub the env — if a code path under test reads
process state, that state should be a parameter you pass in.

**Constructor note**: `vi.spyOn` on a `new`-called function requires `mockImplementation` with a
**regular function** (not arrow — arrows can't be constructors). Return the instance from inside
the function.

Add new deps to `node-deps.ts` as needed. For shared mutable objects like `logger`, spy methods
directly on the object without a wrapper.

### Spy helpers in `@tests/stubs`

`vi.spyOn` is call-through by default, which is risky for I/O primitives - a missed mock can hit
the real network or filesystem. Use the fail-loudly-by-default helpers in
`@tests/stubs/index.js` (re-exports from `tests/stubs/node-deps.ts` and `tests/stubs/admin.ts`)
instead of bare `vi.spyOn` for fetch, dotenv, fs writes, env, and the kafka admin client. Read
each helper's JSDoc for its shape and usage.

When stubbing a primitive that doesn't yet have a helper, follow the same fail-loudly pattern
at the test site (see `mockFetch` in `tests/stubs/node-deps.ts` as the reference shape).

### When to extend `node-deps.ts` vs. stub one level deeper

The general rule: wrap external I/O at the lowest stable boundary you control. If production code
calls a Node builtin or third-party primitive that isn't already in `node-deps.ts`, add it there
and spy on the wrapper. If the primitive is already wrapped (like `nodeCrypto.randomBytes`) and a
project-local function just composes around it, stub the primitive — there's no need to also wrap
the composing function. `generateApiKey` in `src/mcp/transports/auth.ts` is an example: tests stub
`nodeCrypto.randomBytes` rather than wrapping `generateApiKey` in its own namespace.

### Why `vi.mock` is not used in this project

`vi.spyOn` and `vi.mock` solve different problems. `vi.spyOn` is a runtime property mutation
(the same class of operation as `sandbox.stub(obj, "method")` was under Sinon). `vi.mock`
rewrites the module graph before imports resolve: it's hoisted above `import` statements,
scoped to the file that calls it, and applies for the entire test file at once.

The project settled on the `vi.spyOn` + namespace-object combination because it gives:

- **Per-test granularity.** Each test installs exactly the spies it needs; `restoreMocks: true`
  wipes them between tests. With `vi.mock`, mock identity is shared across the whole file and
  per-test behavior changes still require `vi.mocked(fn).mockReturnValue(...)` calls anyway,
  just with a file-header declaration on top.
- **Type safety on the real boundary.** Spies land on the actual imported value, so if the
  real module's API changes, TypeScript flags the test immediately. `vi.mock` factories drift
  silently when the real module's shape changes.
- **Accessor-mode spies for getters.** `vi.spyOn(obj, "prop", "get")` powers the `buildConfig`
  pattern (and any future getter-on-namespace seam); there's no clean `vi.mock` equivalent for
  per-test value changes.
- **No hoisting surprises.** Execution order in tests matches source order. `vi.mock` is
  hoisted by the Vitest transformer, which can confuse readers trying to trace setup.
- **Integration tests stay simple.** `*.integration.test.ts` files default to real I/O. A
  file-scoped or setup-file `vi.mock` approach would invert that default, requiring explicit
  `vi.unmock` calls in every integration test.

Every dependency in this codebase that resists direct spying can be wrapped in a namespace
object. **Do not reach for `vi.mock`** - if a new dependency seems to require it, wrap it in
`node-deps.ts` or a similar namespace object and spy on the wrapper instead.

## Handler Tests

- Test `getToolConfig()` (name, description, input schema, annotations).
- Test `enabledConnectionIds(runtime)` against representative `ServerRuntime` fixtures: a runtime
  whose connection has the relevant service block (expect the connection id) and a bare runtime
  without that block (expect `[]`). Helper factories live in `tests/factories/runtime.ts`
  (`flinkRuntime()`, `tableflowRuntime()`, `bareRuntime()`, etc.).
- Test `handle()` for typical and edge-case inputs using `getMockedClientManager` +
  `assertHandleCase` from `@tests/stubs/index.js`. The standard three cases per
  config-backed parameter: (1) throws when arg absent and not in config, (2) resolves
  using config fallback, (3) resolves using explicit arg. Use `HandleCaseWithConn` to
  carry a per-case runtime shape (`connectionConfig: {}` for throw cases; domain fixture
  as default for success cases). Pass `"DISCOVER"` as the `outcome` sentinel to run the
  handler and get a copy-paste suggestion for the correct expectation; replace before
  committing.

  `getMockedClientManager()` returns a `MockedClientManager` (a
  `Mocked<DirectClientManager>` whose client-getters are narrowed to return
  `Mocked<...>` of the corresponding production client). Tests retrieve a typed
  mock from the manager and configure return values per-method on the
  specific client(s) the handler exercises. Sync getters (the six REST clients
  and Schema Registry) return the mock directly; async Kafka getters need an
  `await`:

  ```typescript
  const clientManager = getMockedClientManager();

  // openapi-fetch (sync getter):
  clientManager
    .getConfluentCloudFlinkRestClient()
    .GET.mockResolvedValue({ data: { items: [] } });

  // KafkaJS (async getter):
  const admin = await clientManager.getAdminClient();
  admin.listTopics.mockResolvedValue(["topic-a"]);

  // SchemaRegistryClient (sync getter):
  clientManager.getSchemaRegistryClient().getAllSubjects.mockResolvedValue([]);

  await assertHandleCase({
    handler,
    runtime: runtimeWith(
      connectionConfig,
      DEFAULT_CONNECTION_ID,
      clientManager,
    ),
    args,
    outcome,
    clientManager,
  });
  ```

  Two invariants are load-bearing:
  - **Same getter, same mock.** Each `cm.getXxx()` getter is wired with
    `mockReturnValue`, so every call returns the same mock instance. A
    `const flinkRest = cm.getConfluentCloudFlinkRestClient()` captured in
    setup stays valid for assertions after the handler runs, and the
    handler's own getter call lands on the same mock the test configured.
  - **Build per test, not per suite.** Invoke `getMockedClientManager()`
    once per test — either inline in each `it` body or by reassigning a
    suite-scope `let` from a `beforeEach`. The anti-pattern is a
    suite-scope `const cm = getMockedClientManager()` that runs once: with
    that shape, vitest's
    [`restoreMocks: true`](https://vitest.dev/config/restoremocks) (which
    only restores `vi.spyOn` originals) won't touch the manager's
    `vi.fn()`s, so call histories and configured return values leak across
    tests in the suite. To share setup across tests, rebuild in
    `beforeEach`:

    ```typescript
    let clientManager: MockedClientManager;

    beforeEach(() => {
      clientManager = getMockedClientManager();
    });

    it("...", async () => {
      const flinkRest = clientManager.getConfluentCloudFlinkRestClient();
      flinkRest.GET.mockResolvedValue({ data: { items: [] } });
      // ...
    });
    ```

  For poll-then-fetch flows or any case where a method returns different data
  on successive calls, chain `mockResolvedValueOnce`:

  ```typescript
  const flinkRest = clientManager.getConfluentCloudFlinkRestClient();
  flinkRest.GET.mockResolvedValueOnce({
    data: { status: { phase: "RUNNING" } },
  }).mockResolvedValue({ data: { data: [] } });
  ```

  Asserting a POST body (when `outcome.resolves` doesn't prove the payload):

  ```typescript
  const flinkRest = clientManager.getConfluentCloudFlinkRestClient();
  expect(flinkRest.POST).toHaveBeenCalledOnce();
  expect(flinkRest.POST).toHaveBeenCalledWith(
    expect.stringContaining("/statements"),
    expect.objectContaining({
      body: expect.objectContaining({
        spec: expect.objectContaining({
          properties: expect.objectContaining({
            "sql.current-catalog": "env-name-from-config",
          }),
        }),
      }),
    }),
  );
  ```

  Asserting that a different client was not touched (negative assertions are
  first-class because each seam has its own mock):

  ```typescript
  expect(
    clientManager.getConfluentCloudKafkaRestClient().POST,
  ).not.toHaveBeenCalled();
  expect(
    clientManager.getConfluentCloudFlinkRestClient().GET,
  ).not.toHaveBeenCalled();
  ```

  For tests that need a single typed mock without the full
  `getMockedClientManager` wiring (e.g., focused unit tests against one seam),
  the per-client helpers are exported directly: `getMockedRestClient()`,
  `getMockedAdmin()`, `getMockedProducer()`, `getMockedConsumer()`,
  `getMockedSchemaRegistry()`.

- When a test would otherwise extend `HandleCaseWithConn` with extra per-case fields (e.g.
  `mockResponse`, `expectedEnvId`, body-of-the-mocked-GET), check the existing exports in
  `tests/factories/runtime.ts` first — common shapes are already shared there. If the same
  extension would appear (or already does) in another test file, hoist it next to the
  existing exports rather than declaring a fresh per-file alias; future readers grepping
  for the right type to import shouldn't be greeted by N differently-named copies of the
  same shape.

- Use `as any` only on partial mock return values (e.g., a mock admin client with only
  `listTopics`), not on the `ClientManager` mock itself; add an eslint-disable comment when needed.

## Test Server & Runtime Fixtures

- `createTestServer(clientManager, toolNames?)` from `@tests/server.js` boots a real `McpServer`
  with all tools (or a passed subset) wired to a stubbed `ClientManager` over `InMemoryTransport`.
  Use it for protocol-level integration tests.
- For `enabledConnectionIds()` tests, build a `ServerRuntime` via the named factories in
  `@tests/factories/runtime.js`: `bareRuntime()`, `kafkaRuntime()`, `flinkRuntime()`,
  `tableflowRuntime()`, `schemaRegistryRuntime()`, `confluentCloudRuntime()`,
  `telemetryRuntime()`, etc. For uncommon shapes, use `runtimeWith(connectionConfig?, connectionId?)` (both args optional; `connectionId` defaults to `"default"`).
