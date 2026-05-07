---
paths:
  - "src/confluent/tools/**/*.ts"
---

# MCP Tool Handler Conventions

## Before you start: read a neighbor

This is no longer a greenfield. There are 50+ tools in `src/confluent/tools/handlers/`, each
already exercising the conventions below in production. **Before writing a new tool, read at
least one existing handler in the same domain end-to-end** — handler class, colocated `.test.ts`,
and the registration line in `tool-registry.ts`. The fastest way to get a new tool right is to
mimic the closest working sibling. The rules below describe the abstract contract; the existing
handlers show the lived shape (imports, predicate choice, Zod arg patterns, response idioms,
test layout).

If the closest sibling is doing something different from what this rule says, prefer the
sibling's pattern and flag the rule as drift — neighboring tools are the source of truth for
"what we actually do," and this document follows them.

## Handler Structure

Every tool handler follows this pattern:

1. **Pick a base class:**
   - If a domain subclass exists (e.g., `FlinkToolHandler`, `TableflowToolHandler` under `handlers/<domain>/`), extend it. The subclass already declares the domain `predicate`, so you don't repeat it per tool.
   - Otherwise extend `BaseToolHandler` from `@src/confluent/tools/base-tools.js` directly. If a domain has more than one tool with the same predicate, introduce a domain subclass first and extend that.
2. **Implement these members:**
   - `getToolConfig()` → returns `{ name: ToolName, description: string, inputSchema: zodSchema.shape, annotations: ToolAnnotations }`. Use one of the shared annotation constants exported from `base-tools.ts`: `READ_ONLY`, `CREATE_UPDATE`, or `DESTRUCTIVE` (don't construct ad-hoc instances).
   - `handle(runtime, toolArguments, sessionId?)` → returns `Promise<CallToolResult>`.
   - `readonly predicate` (skip if you inherited it from a domain subclass) → a `ConnectionPredicate` from `connection-predicates.ts` that gates tool enablement. Declared as a one-liner property, never as a method:
     ```typescript
     readonly predicate = hasKafka;                  // base predicate
     readonly predicate = kafkaBootstrapOrOAuth;     // named composite
     readonly predicate = alwaysEnabled;             // no requirement
     ```
     **The `predicate` property must reference a named export from `connection-predicates.ts`. No inline composition at the use site.** `widenForOAuth(...)` and `allOf(...)` are predicate-library construction tools, not handler-side glue. If no existing named export expresses the gate you need, the path is: add a named `const` export to `connection-predicates.ts` → add a per-predicate test in `connection-predicates.test.ts` matching the depth of the existing `hasKafka` / `flinkWithTelemetry` blocks (direct-enabled, each conjunct's failure mode, OAuth verdict) → add the new export to `NAMED_PREDICATES` in the `predicate property` block of `tool-registry.test.ts` → reference the new export from your handler. Promotion is a precondition of adding the handler, not a followup. Enforced mechanically: that `NAMED_PREDICATES` set is typed `ReadonlySet<ConnectionPredicate>` so combinators cannot compile in, and the per-tool assertion fails with the offending tool name in the row label whenever a handler's `predicate` is not in the set — whether because of inline composition or because the allow-list was not updated alongside a new predicate. `BaseToolHandler` derives `enabledConnectionIds()` and `connectionVerdicts()` from this property. **Do not override either method** — they are `@final`. The retired iteration helpers `connectionIdsWhere`/`connectionReasonsWhere` are no longer exported.

## Input Schema

- Define a Zod object schema as a `const` above the class (e.g., `const listTopicArgs = z.object({...})`)
- Pass `.shape` (not the schema itself) to `inputSchema` in `getToolConfig()`
- Use `.describe()` on every field — these descriptions surface to the AI assistant as tool parameter docs

## Response Pattern

- Use `this.createResponse(message, isError, _meta?)` inherited from `BaseToolHandler`
- `_meta` is an optional object for structured data the AI can use beyond the text message
- Parse `toolArguments` with the Zod schema at the top of `handle()` for validation
- `BaseToolHandler` and domain subclasses (e.g. `FlinkToolHandler`) expose protected convenience helpers for common parameter patterns (required vs. optional arg/config fallback, domain-specific ID resolution). Read those classes before writing inline fallback logic.

## Registration Checklist

When adding a new tool, touch these files:

1. `src/confluent/tools/tool-name.ts` — add enum entry (e.g., `MY_TOOL = "my-tool"`)
2. `src/confluent/tools/handlers/<domain>/my-tool-handler.ts` — create handler class
3. `src/confluent/tools/tool-registry.ts` — import handler and add `[ToolName.MY_TOOL, new MyToolHandler()]` to the `ToolHandlerRegistry.handlers` map
4. `src/index.test.ts` — classify the new `ToolName` in the capstone partition test by adding it to either `EXPECTED_OAUTH_ENABLED` or `EXPECTED_OAUTH_DISABLED`. The partition test fails if a tool belongs to neither — the guard against birthing a tool without thinking about its OAuth posture.
5. (Only if needed) `src/confluent/tools/connection-predicates.ts` — add a new predicate if no existing one expresses the tool's requirement. A new gate must land as a named `const` here (with a per-predicate test in `connection-predicates.test.ts`) before the handler that consumes it; the new predicate also needs adding to the `NAMED_PREDICATES` allow-list in `tool-registry.test.ts`'s `predicate property` block, otherwise the per-tool membership assertion will fail.

## Connection Predicates

Tool enablement is decided by inspecting which **service blocks** are present in each `ConnectionConfig` (Kafka, Flink, Schema Registry, Confluent Cloud, Tableflow, Telemetry). Predicates in `connection-predicates.ts` express those checks as pure functions returning a `PredicateResult` (enabled, or disabled with a reason). Each handler names one as its `predicate` property; `BaseToolHandler` walks `runtime.config.connections` against it to derive `enabledConnectionIds()` and `connectionVerdicts()`.

**Invariant: a predicate must guarantee the tool has at least one valid invocation path.** A tool should be advertised as enabled if callers can succeed — either because the required values are present in config, or because the handler accepts them as explicit tool arguments. A predicate that requires only a service block (e.g. `conn.kafka !== undefined`) is correct even if some fields within that block are optional, as long as callers can supply those fields as arguments. The goal is that no enabled tool _always_ throws regardless of how it is called — the predicate is a pre-flight check, not a guarantee of zero-argument success.

- A tool whose predicate matches zero connections is automatically disabled.
- A tool with no service-specific requirement uses `alwaysEnabled` from `connection-predicates.ts`.
- New predicates should be additive and pure; they read the `ConnectionConfig` shape only and return a `PredicateResult` with a `ToolDisabledReason` on failure.

When you need a gate the library doesn't yet publish, add a new named `const` export to `connection-predicates.ts` (then reference it from the handler — see the rule above). Two combinators inside the library make composition safe:

- `allOf(p1, p2, ...)` for compound requirements — never raw `&&`, which silently drops the first operand because every `PredicateResult` is a truthy object.
- `widenForOAuth(p)` to admit OAuth through a block-based predicate, for handlers genuinely adapted to operate against an OAuth connection at call time.

These combinators are construction tools used to define new named exports; they are not for inline use at the handler site. After adding the named export, give it a per-predicate test in `connection-predicates.test.ts` (modelled on the existing blocks: direct-enabled, each conjunct's failure mode, OAuth verdict) before the handler that consumes it lands.

The named-export-only rule is enforced by the `predicate property` block in `tool-registry.test.ts`, which maintains an explicit `NAMED_PREDICATES` allow-list typed as `ReadonlySet<ConnectionPredicate>` (so combinators can't compile in) and asserts every handler's `predicate` is a member. Use it as the "did I get the wiring right" oracle — if the test fails for your tool, the row label names which handler is the problem and the assertion message distinguishes the two failure modes (inline composition vs. forgot to update the allow-list).

### `hasConfluentCloud` vs `hasDirectConfluentCloud` — pick carefully

`hasConfluentCloud` returns `true` for **both** direct connections with a `confluent_cloud`
block **and** OAuth connections. `hasDirectConfluentCloud` returns `true` only for direct
connections.

**If `handle()` calls `runtime.config.getSoleDirectConnection()`** (which narrows to
`DirectConnectionConfig` and throws for OAuth connections), the predicate **must** be
`hasDirectConfluentCloud`. Using `hasConfluentCloud` here enables the tool for OAuth
connections but then crashes at call time — the tool is advertised as available but always
throws. This mismatch has burned us more than once.

Rule of thumb: reach for `hasDirectConfluentCloud` when the handler reads service-block
fields (`.kafka`, `.flink`, `.confluent_cloud`, etc.) from the connection. Only widen to
`hasConfluentCloud` once the handler is genuinely OAuth-capable (i.e. it no longer calls
`getSoleDirectConnection()` and doesn't read direct-only fields). When widening, add an
`enabledConnectionIds()` test against `ccloudOAuthRuntime()` that confirms the tool is
enabled for OAuth.

## File Organization

Handlers live under `src/confluent/tools/handlers/<domain>/`:

```
handlers/
├── billing/      # billing API
├── catalog/      # tags, catalog search
├── clusters/     # cluster management
├── connect/      # connectors
├── environments/ # environment CRUD
├── flink/        # Flink SQL + catalog/ + diagnostics/ (flink-tool-handler.ts is the domain base)
├── kafka/        # topics, produce, consume, config
├── metrics/      # telemetry metric discovery + query
├── organizations/ # Confluent Cloud organization listing
├── schema/       # Schema Registry
├── search/       # topic search
└── tableflow/    # Tableflow topics + catalog/ (tableflow-tool-handler.ts is the domain base)
```

## Import Conventions

- Use `@src/` path alias for all internal imports
- Use `.js` extensions on import paths (ESM requirement)
- Standard imports for a handler that extends `BaseToolHandler` directly:
  ```typescript
  import { CallToolResult } from "@src/confluent/schema.js";
  import {
    BaseToolHandler,
    READ_ONLY,
    ToolConfig,
  } from "@src/confluent/tools/base-tools.js";
  import { hasSchemaRegistry } from "@src/confluent/tools/connection-predicates.js";
  import { ToolName } from "@src/confluent/tools/tool-name.js";
  import { ServerRuntime } from "@src/server-runtime.js";
  import { z } from "zod";
  ```
  Import only the predicate(s) you actually name on the `predicate` property. Do not import `connectionIdsWhere` or `connectionReasonsWhere` — those helpers were retired; the base class iterates for you.
- For a handler that extends a domain subclass, drop `BaseToolHandler`, the predicate import, and `ServerRuntime` (the subclass owns those):
  ```typescript
  import { CallToolResult } from "@src/confluent/schema.js";
  import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
  import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
  import { ToolName } from "@src/confluent/tools/tool-name.js";
  import { z } from "zod";
  ```
