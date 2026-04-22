---
paths:
  - src/**/*.test.ts
  - tests/**/*
---

# Unit Testing (Vitest)

## Framework & Location

- Co-located `.test.ts` files alongside source code using Vitest
- Run with `npm run test` (single run) or `npm run test:watch` (watch mode)
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
- For argument matching inside calls: `expect.any(String)`, `expect.objectContaining({...})`,
  `expect.stringContaining("...")`, `expect.anything()`

## Key Patterns

- Use `createMockInstance(DefaultClientManager)` (from `@tests/stubs/index.js`) for handler tests
  with one class dependency. The returned object is typed as `Mocked<DefaultClientManager>` so
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

Vitest can only spy on **module exports that resolve to object properties**, not on ESM live
bindings at runtime. This is inherent to the ESM spec — imports are sealed after evaluation.

**Solutions:**

- Extract dependencies to separate modules
- Pass dependencies as parameters
- Use namespace objects (see `node-deps.ts`, `authUtils` pattern) so callers access via property
  lookup instead of a bare named import

### ESM Live Bindings and `node-deps.ts`

`@src/confluent/node-deps.js` re-exports Node builtins, third-party constructors, and env access
as plain objects whose properties Vitest can spy on:

```typescript
// source file
import { fs, os, segment, config } from "@src/confluent/node-deps.js";
fs.readFileSync(path); // node builtins
new segment.Analytics({ key }); // third-party constructors
config.env.DO_NOT_TRACK; // env proxy

// test file
import * as nodeDeps from "@src/confluent/node-deps.js";
vi.spyOn(nodeDeps.fs, "readFileSync").mockReturnValue("content");
vi.spyOn(nodeDeps.segment, "Analytics").mockImplementation(function () {
  return { track: trackStub };
} as any);
vi.spyOn(nodeDeps.config, "env", "get").mockReturnValue({
  DO_NOT_TRACK: false,
} as any);
```

**Constructor note**: `vi.spyOn` on a `new`-called function requires `mockImplementation` with a
**regular function** (not arrow — arrows can't be constructors). Return the instance from inside
the function.

Add new deps to `node-deps.ts` as needed. For shared mutable objects like `logger`, spy methods
directly on the object without a wrapper.

### Other namespace-object patterns

The same idea applies outside `node-deps.ts` — any exported free function that callers want to
stub should live inside a namespace object. Example: `authUtils.generateApiKey` in
`src/mcp/transports/auth.ts`. Tests spy via `vi.spyOn(authUtils, "generateApiKey")`.

**Do not use `vi.mock`** as an escape hatch. It hoists above imports, loses type safety, and
splits the project's stubbing mental model. If something can't be stubbed, wrap it first.

## Handler Tests

- Test config (`getToolConfig()`), required env vars (`getRequiredEnvVars()`), and behavior (`handle()`)
- Stub `ClientManager` methods with `createMockInstance(DefaultClientManager)`
- Use `as any` only on partial mock return values (e.g., a mock admin client with only
  `listTopics`), not on the `ClientManager` mock itself — add an eslint-disable comment when needed

## Environment Proxy

- `createTestServer()` calls `initEnv()` automatically so Zod `.default()` callbacks in tool
  schemas don't throw
- For handler-only tests that don't use `createTestServer()`, call `initEnv()` in `beforeAll` if
  the handler's Zod schema references `env.*` in `.default()` callbacks
