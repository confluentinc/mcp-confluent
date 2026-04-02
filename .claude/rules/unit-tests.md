---
paths:
  - src/**/*.test.ts
  - tests/**/*
---

# Unit Testing (Vitest + Sinon)

## Framework & Location

- Co-located `.test.ts` files alongside source code using Vitest + Sinon
- Run with `npm run test` (single run) or `npm run test:watch` (watch mode)
- Config in `vitest.config.ts`; `@src/*` aliases resolved via `resolve.tsconfigPaths` in Vitest config

## Test Naming

- Use the "should ..." convention: `it("should return a list of topics", ...)`
- Group related tests with `describe` blocks named after the unit under test

## Assertions

- Prefer `sinon.assert` for stub/spy call verification (e.g., `sinon.assert.calledOnce(stub)`,
  `sinon.assert.calledWith(stub, arg)`) - produces descriptive failure messages instead of bare
  "expected false to be true"
- Use Vitest `expect` for non-Sinon values (return data, thrown errors, data structures)

## Key Patterns

- Use `sinon.createStubInstance(DefaultClientManager)` for simple handler tests with one class dep
- Use `sinon.createSandbox()` when a test needs many stubs with coordinated cleanup (call
  `sandbox.restore()` in `afterEach`)
- Don't wrap simple one-liners in helper functions
- Use `createTestServer()` from `@tests/server` for integration-style tests that need a
  full MCP server + client connected via `InMemoryTransport`
- Focus on isolated behavior, mocking external dependencies
- Do not test or stub side effects like logging - no logger stubs or assertions needed
- Only stub what affects behavior - pure-value functions like `os.platform()` don't need stubbing
  when `sinon.match.string` suffices for assertions
- Access private/protected members via bracket notation in tests: `obj["privateProp"]`
- Set up common stubs in the top-level `describe` block so they apply to all tests

## Design for Stubbing

Sinon can only stub **module exports**, not internal calls within the same file.

**Solutions:**

- Extract dependencies to separate modules
- Pass dependencies as parameters
- Use dependency injection patterns

### ESM Live Bindings and `node-deps.ts`

Sinon can't stub ESM live bindings at runtime - this affects Node builtins (sealed per spec) and
Vite-transformed module exports alike. `@src/confluent/node-deps.js` re-exports these as plain
objects whose properties Sinon can stub:

```typescript
// source file
import { fs, os, segment, config } from "@src/confluent/node-deps.js";
fs.readFileSync(path); // node builtins
new segment.Analytics({ key }); // third-party constructors
config.env.DO_NOT_TRACK; // env proxy

// test file
import * as nodeDeps from "@src/confluent/node-deps.js";
sandbox.stub(nodeDeps.fs, "readFileSync").returns("content");
sandbox.stub(nodeDeps.segment, "Analytics").returns({ track: trackStub });
sandbox.stub(nodeDeps.config, "env").value({ DO_NOT_TRACK: false });
```

Add new deps to `node-deps.ts` as needed. For shared mutable objects like `logger`, stub methods
directly on the object without a wrapper.

## Handler Tests

- Test config (`getToolConfig()`), required env vars (`getRequiredEnvVars()`), and behavior (`handle()`)
- Stub `ClientManager` methods with `sinon.createStubInstance(DefaultClientManager)`
- Use `as any` only on partial mock return values (e.g., a mock admin client with only `listTopics`),
  not on the `ClientManager` stub itself — add an eslint-disable comment when needed

## Environment Proxy

- `createTestServer()` calls `initEnv()` automatically so Zod `.default()` callbacks in tool schemas
  don't throw
- For handler-only tests that don't use `createTestServer()`, call `initEnv()` in `beforeAll` if the
  handler's Zod schema references `env.*` in `.default()` callbacks
