---
name: sinon
description:
  Use when the user asks about Sinon stubbing, spying, mocking, or test double APIs for unit tests.
  Triggers on questions like "how do I stub this", "Sinon fake timers", "spy vs stub",
  "assert.calledWith", "stub.resolves", "sinon.match", "createStubInstance", or test double patterns.
allowed-tools: Read, Bash, WebFetch, WebSearch
---

# Sinon.JS Documentation Lookup

This skill helps look up Sinon.JS APIs, patterns, and best practices for creating test doubles in
unit tests for this MCP server project (Vitest + Sinon).

## Sources

### Sinon.JS Documentation (v18)

The official docs organized by feature at `https://sinonjs.org/releases/v18/`:

| Section     | URL                                                     | Use For                                         |
| ----------- | ------------------------------------------------------- | ----------------------------------------------- |
| Overview    | `https://sinonjs.org/releases/v18/`                     | General concepts, what's new                    |
| Spies       | `https://sinonjs.org/releases/v18/spies/`               | Observing function calls without changing them  |
| Stubs       | `https://sinonjs.org/releases/v18/stubs/`               | Replacing functions with controlled behavior    |
| Mocks       | `https://sinonjs.org/releases/v18/mocks/`               | Pre-programmed expectations (use sparingly)     |
| Fakes       | `https://sinonjs.org/releases/v18/fakes/`               | Immutable spies with optional behavior          |
| Sandbox     | `https://sinonjs.org/releases/v18/sandbox/`             | Automatic cleanup of stubs/spies/mocks          |
| Fake Timers | `https://sinonjs.org/releases/v18/fake-timers/`         | Controlling `setTimeout`, `setInterval`, `Date` |
| Fake XHR    | `https://sinonjs.org/releases/v18/fake-xhr-and-server/` | Faking HTTP requests                            |
| Assertions  | `https://sinonjs.org/releases/v18/assertions/`          | Sinon-specific assertion helpers                |
| Matchers    | `https://sinonjs.org/releases/v18/matchers/`            | Argument matching for assertions                |

## Process

### 1. Understand the Question Context

Determine whether the user needs:

- **API reference**: Exact method signatures, options, return values
- **Pattern guidance**: How to set up stubs, verify calls
- **Troubleshooting**: Why a stub isn't working, common pitfalls
- **Best practices**: Project-specific conventions for test doubles

### 2. Check Project Conventions First

Before fetching external docs, review the project's test conventions:

- **`sinon.createStubInstance()`** for simple handler tests that only need a stubbed class instance
- **`sinon.createSandbox()`** for tests with many stubs needing coordinated cleanup (e.g.,
  `telemetry.test.ts`). Call `sandbox.restore()` in `afterEach`
- **Sinon assertions for stubs/spies** - prefer `sinon.assert` (not `expect().toBe(true)`) when
  verifying stub/spy call behavior; use Vitest `expect` for non-Sinon values (return data, errors)
- **`sinon.createStubInstance()`** is the primary pattern for stubbing class dependencies (e.g.,
  `sinon.createStubInstance(DefaultClientManager)`)
- Design for stubbing: avoid calling same-module functions you need to stub - Sinon can only stub
  module exports, not internal calls within the same file
- Extract dependencies to separate modules or pass them as parameters
- Common stubs go in the top-level `describe` block's `beforeEach`
- Factory functions in `tests/stubs/` for complex types that can't use `createStubInstance` (e.g.,
  `createStubAdmin()` for `KafkaJS.Admin` which is a type alias, not a class)

### 3. Fetch Documentation

Sinon docs are organized by feature - fetch the specific section page:

```
WebFetch: https://sinonjs.org/releases/v18/stubs/
Prompt: "Find the API documentation for [specific method like stub.resolves, stub.callsFake, etc.]"
```

For general best practices or newer features, supplement with web search:

```
WebSearch: "sinon.js stub resolves rejects async example"
WebSearch: "sinon createStubInstance typescript"
```

### 4. Look at Existing Test Examples

When the user needs pattern guidance, look at how the project uses Sinon:

```bash
# Find test files using stubs
grep -r "sinon.stub\|createStubInstance" --include="*.test.ts" -l src/ | head -5

# Find stub factory usage
grep -r "createStub" --include="*.ts" -l tests/ | head -5

# Find specific patterns
grep -r "stub\.resolves\|stub\.returns\|stub\.callsFake" --include="*.test.ts" -l src/ | head -5
```

Read 1-2 relevant test files to show project-specific patterns alongside official docs.

### 5. Search for Specific APIs

When the user asks about a specific API (e.g., `stub.resolves()`, `createStubInstance()`):

1. Fetch the relevant Sinon section page (stubs, sandbox, etc.)
2. Search for the specific method or property
3. Extract the API signature with description and examples
4. Cross-reference with project usage if applicable

## Output Format

### API Reference

```markdown
## Sinon: [method/feature]

### API

[Method signature and description from docs]

### Example

[Code example from docs or adapted to project patterns]

### Project Usage

[How this is typically used in the project, with file references if found]
```

### Pattern Guidance

```markdown
## Pattern: [description]

### From the Docs

[Official recommended approach]

### In This Project

[How the project implements this pattern, with examples from existing tests]

### Key Points

- [Important considerations]
- [Common pitfalls to avoid]
```

## Common Lookup Patterns

### createStubInstance (project default for classes)

Stub an entire class with type-safe stubs - preferred for `DefaultClientManager` and similar:

- **Create**: `const cm = sinon.createStubInstance(DefaultClientManager)`
- **Configure**: `cm.getAdminClient.resolves(admin as KafkaJS.Admin)`
- **Cleanup**: handled by Vitest's `restoreMocks: true` - no manual restore needed

### Stub Factories (for non-class types)

For type aliases or interfaces that can't use `createStubInstance`, create factory functions in
`tests/stubs/`:

- **Pattern**: export a typed object with `sinon.stub()` for each method
- **Example**: `createStubAdmin()` returns a `StubbedAdmin` with all `KafkaJS.Admin` methods stubbed
- **Usage**: `const admin = createStubAdmin(); admin.listTopics.resolves([...])`

### Stubs

- **Behavior**: `stub.returns(val)`, `stub.resolves(val)`, `stub.rejects(err)`,
  `stub.callsFake(fn)`, `stub.throws(err)`
- **Conditional**: `stub.withArgs(arg).returns(val)`, `stub.onFirstCall().returns(val)`
- **Reset**: `stub.reset()`, `stub.resetBehavior()`, `stub.resetHistory()`

### Spies

- **Inspect**: `spy.calledOnce`, `spy.calledWith(arg)`, `spy.returnValues`, `spy.args`
- **Count**: `spy.callCount`, `spy.firstCall`, `spy.secondCall`, `spy.lastCall`

### Assertions (`sinon.assert` preferred for stubs/spies)

Prefer `sinon.assert` over `expect()` when asserting on stubs and spies - it produces descriptive
failure messages (e.g., "expected stub to be called once but was called 0 times") instead of bare
"expected false to be true":

- `sinon.assert.calledOnce(spy)`
- `sinon.assert.calledWith(spy, arg1, arg2)`
- `sinon.assert.calledOnceWithExactly(spy, arg1)`
- `sinon.assert.notCalled(spy)`
- `sinon.assert.callOrder(spy1, spy2)`
- `sinon.assert.callCount(spy, n)`

Use Vitest `expect` for non-Sinon assertions (return values, thrown errors, data structures):

- `expect(result).toEqual(expected)`
- `expect(result.topics).toHaveLength(3)`

### Fake Timers

- **Create**: `sinon.useFakeTimers()`, `sinon.useFakeTimers({ now: timestamp })`
- **Control**: `clock.tick(ms)`, `clock.tickAsync(ms)`, `clock.next()`, `clock.runAll()`
- **Cleanup**: call `clock.restore()` in `afterEach`

### Matchers

- **Type**: `sinon.match.string`, `sinon.match.number`, `sinon.match.func`, `sinon.match.object`
- **Partial**: `sinon.match({ key: value })`, `sinon.match.has('key', value)`
- **Custom**: `sinon.match(predicate)`, `sinon.match.any`

## Tips

- **Use `createStubInstance`** for simple tests with one class dependency (e.g.,
  `DefaultClientManager`), **`createSandbox()`** when multiple stubs need coordinated cleanup.
  Call `sandbox.restore()` in `afterEach`. Don't wrap simple one-liners in helper functions
- Only create stub factory functions (in `tests/stubs/`) for types that can't use
  `createStubInstance` (e.g., type aliases like `KafkaJS.Admin`)
- Sinon docs are organized by feature - fetch the specific section page rather than the overview for
  API details
- When the user asks "how do I stub X", first check whether the function is an export from another
  module (stubbable) vs. an internal call within the same file (needs restructuring)
- Prefer `sinon.assert` for stub/spy assertions (better failure messages); use Vitest `expect` for
  non-Sinon values. Adapt any Chai-based examples from docs accordingly
- `stub.resolves()` / `stub.rejects()` are the async-friendly counterparts to `stub.returns()` /
  `stub.throws()` - use these for Promise-based code
- For integration-style tests, use `createTestServer()` from `tests/server.ts` which provides an
  MCP server + client connected via `InMemoryTransport`
