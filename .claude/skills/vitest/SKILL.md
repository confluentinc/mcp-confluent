---
name: vitest
description:
  Use when the user asks about Vitest mocking, spies, stubs, fake timers, config, or test runner
  behavior. Triggers on questions like "vi.fn", "vi.spyOn", "vi.mocked", "Mocked<T>",
  "mockResolvedValue", "restoreMocks", "vitest mock", "createMockInstance", "useFakeTimers", or
  how to accomplish test double patterns with Vitest.
allowed-tools: Read, Bash, WebFetch, WebSearch
---

# Vitest Documentation Lookup

Look up Vitest APIs, patterns, and best practices via WebFetch against the official docs. Use this
skill to answer questions about `vi.*`, mock instances, assertions, fake timers, and config
options. Project-specific test conventions (naming, stubbing strategy, `node-deps.ts` pattern) live
in `.claude/rules/unit-tests.md` - reference that rule rather than re-deriving the conventions.

## Sources

Base URL: `https://vitest.dev`

| Topic             | Path                       | Use for                                                         |
| ----------------- | -------------------------- | --------------------------------------------------------------- |
| Getting started   | `/guide/`                  | General concepts, project setup, runner behavior                |
| Mocking guide     | `/guide/mocking`           | Worked examples: modules, timers, dates, classes                |
| Config reference  | `/config/`                 | `vitest.config.ts` options (`restoreMocks`, `pool`, coverage)   |
| `vi` API          | `/api/vi`                  | Top-level helpers (`vi.fn`, `vi.spyOn`, `vi.mocked`, timers)    |
| Mock instance API | `/api/mock`                | Methods on a `Mock` (`.mockReturnValue`, `.mockImplementation`) |
| Assertions        | `/api/expect`              | `expect()` matchers, argument matchers                          |
| Fake timers       | `/api/vi#vi-usefaketimers` | `vi.useFakeTimers`, `advanceTimersByTimeAsync`                  |
| CLI               | `/guide/cli`               | `vitest run`, flags, watch mode                                 |

## Process

1. **Determine the question type**
   - API reference (exact signature, options, return type) → `/api/*` pages
   - Pattern guidance / worked examples → `/guide/mocking` or `/guide/`
   - Config option behavior → `/config/`
   - CLI flag / runner behavior → `/guide/cli`

2. **Check project rules first** - read `.claude/rules/unit-tests.md` before fetching. It already
   documents: `restoreMocks: true` behavior, the `node-deps.ts` / `authUtils` namespace pattern,
   `createMockInstance`, constructor-stub gotchas, and the `vi.mock` anti-pattern. Don't re-explain
   these; cite the rule and only fetch docs for anything beyond it.

3. **Fetch the relevant page** with WebFetch:

   ```
   WebFetch: https://vitest.dev/api/mock
   Prompt: "Find the signature and options for [specific method, e.g. mockImplementationOnce]"
   ```

   For cross-cutting questions (e.g. "how do I mock a class constructor"), fetch the guide page
   (`/guide/mocking`) alongside the API page.

4. **Look at existing project tests** for pattern examples before synthesizing your own:

   ```
   Grep: "vi\.spyOn|createMockInstance|vi\.useFakeTimers" --glob "**/*.test.ts"
   ```

   Good reference files: `src/confluent/telemetry.test.ts` (many spies), `src/cli.test.ts`
   (env-proxy spying), `src/confluent/oauth/token-store.test.ts` (async + timers).

5. **Cross-reference version**: this project is on Vitest v4. If a WebSearch result or older
   example uses `vi.mock` factories or pre-v1 APIs, verify against the v4 `/api/*` page before
   recommending.

## Topic Selection Examples

| User asks about…                                        | Fetch                                                      |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| "how do I stub a class constructor?"                    | `/guide/mocking` + `/api/vi`                               |
| "what's the difference between `vi.fn` and `vi.spyOn`?" | `/api/vi`                                                  |
| "mock returns different value on second call"           | `/api/mock` (`mockReturnValueOnce`)                        |
| "how do I advance fake timers in an async test?"        | `/api/vi#vi-usefaketimers`                                 |
| "what does `restoreMocks` do?"                          | `/config/` (search: restoreMocks)                          |
| "how to type a stubbed class instance?"                 | `unit-tests.md` (project helper) + `/api/vi` (`Mocked<T>`) |
| "argument matcher for partial object"                   | `/api/expect` (`expect.objectContaining`)                  |
| "why can't I spy on this ESM import?"                   | `unit-tests.md` §Design for Stubbing (no fetch needed)     |

## Output Format

### API Reference

```markdown
## Vitest: [method/feature]

### Signature

[From /api/*]

### Example

[Adapted to project patterns where relevant]

### Project usage

[Reference to unit-tests.md section or a real `.test.ts` file if applicable]
```

### Pattern Guidance

```markdown
## Pattern: [description]

### From the docs

[Approach recommended by /guide/mocking or /api/*]

### In this project

[How existing tests implement it; cite file paths]

### Gotchas

[Edge cases - e.g. arrow-fn constructor, ESM live bindings, mock hoisting]
```

## Anti-patterns (project-specific)

- **Don't use `vi.mock`**: it hoists above imports, loses type safety, and splits the project's
  stubbing model. If a dependency can't be spied on, wrap it in a namespace object (see
  `node-deps.ts`, `authUtils` in `src/mcp/transports/auth.ts`). Full rationale in
  `.claude/rules/unit-tests.md` §Design for Stubbing.
- **Don't add `afterEach` restore blocks**: `restoreMocks: true` in `vitest.config.ts` handles it.
- **Don't use arrow functions for constructor mocks**: arrows aren't constructable. Use a regular
  `function` with `vi.spyOn(ns, "Ctor").mockImplementation(function () { return {...}; })`.

## Tips

- Prefer `/api/*` pages for signature lookups, `/guide/*` for worked examples.
- `/api/vi` covers top-level helpers (`vi.fn`, `vi.spyOn`, timers, module hooks); `/api/mock`
  covers methods _on_ a `Mock` instance. Pick the right one based on whether the user is asking
  "how do I create this mock" vs. "how do I configure an existing mock".
- v4 is current. Older blog posts and Stack Overflow answers often show pre-v1 or `vi.mock`-heavy
  patterns - verify against the current API page before recommending.
- For anything that overlaps with `.claude/rules/unit-tests.md`, cite the rule instead of
  duplicating its tables in the response.
