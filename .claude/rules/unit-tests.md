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

- Use `sinon.createStubInstance(DefaultClientManager)` directly for type-safe stubs — don't wrap
  simple one-liners in helper functions
- Use `createTestServer()` from `@tests/server` for integration-style tests that need a
  full MCP server + client connected via `InMemoryTransport`
- Focus on isolated behavior, mocking external dependencies
- Do not test side effects like logging
- Set up common stubs in the top-level `describe` block so they apply to all tests

## Design for Stubbing

Sinon can only stub **module exports**, not internal calls within the same file.

**Solutions:**

- Extract dependencies to separate modules
- Pass dependencies as parameters
- Use dependency injection patterns

### Node Builtins (`node:fs`, `node:os`, etc.)

Sinon refuses to stub Node builtin ESM namespaces because they are sealed per the ES Module spec.
Import from `@src/confluent/node-deps.js` instead of `node:*` directly - it re-exports builtins as
plain objects that Sinon can stub:

```typescript
// source file
import { fs, os, crypto, path } from "@src/confluent/node-deps.js";

// test file
import * as nodeDeps from "@src/confluent/node-deps.js";
sandbox.stub(nodeDeps.fs, "readFileSync").returns("content");
sandbox.stub(nodeDeps.os, "homedir").returns("/tmp/test-home");
```

Add new functions to `node-deps.ts` as needed.

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
