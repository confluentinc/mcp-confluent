---
paths:
  - "src/confluent/tools/**/*.ts"
---

# MCP Tool Handler Conventions

## Handler Structure

Every tool handler follows this pattern:

1. **Pick a base class:**
   - If a domain subclass exists (e.g., `FlinkToolHandler`, `TableflowToolHandler` under `handlers/<domain>/`), extend it. The subclass already implements `enabledConnectionIds()` for the whole domain, so you don't repeat the predicate per tool.
   - Otherwise extend `BaseToolHandler` from `@src/confluent/tools/base-tools.js` directly and implement `enabledConnectionIds()` yourself. If a domain has more than one tool with the same predicate, introduce a domain subclass first and extend that.
2. **Implement these methods (skip `enabledConnectionIds` if you inherited it):**
   - `getToolConfig()` → returns `{ name: ToolName, description: string, inputSchema: zodSchema.shape, annotations: ToolAnnotations }`. Use one of the shared annotation constants exported from `base-tools.ts`: `READ_ONLY`, `CREATE_UPDATE`, or `DESTRUCTIVE` (don't construct ad-hoc instances).
   - `handle(clientManager, toolArguments, sessionId?)` → returns `Promise<CallToolResult>`.
   - `enabledConnectionIds(runtime: ServerRuntime)` → returns `string[]` of connection ids whose YAML satisfies a predicate from `connection-predicates.ts`. The canonical body is a one-liner: `return connectionIdsWhere(runtime.config.connections, hasFoo);`. An empty result disables the tool.

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

When adding a new tool, touch exactly three files (plus optionally a fourth):

1. `src/confluent/tools/tool-name.ts` — add enum entry (e.g., `MY_TOOL = "my-tool"`)
2. `src/confluent/tools/handlers/<domain>/my-tool-handler.ts` — create handler class
3. `src/confluent/tools/tool-registry.ts` — import handler and add `[ToolName.MY_TOOL, new MyToolHandler()]` to the `ToolHandlerRegistry.handlers` map
4. (Only if needed) `src/confluent/tools/connection-predicates.ts` — add a new predicate if no existing one expresses the tool's requirement

## Connection Predicates

Tool enablement is decided by inspecting which **service blocks** are present in each `ConnectionConfig` (Kafka, Flink, Schema Registry, Confluent Cloud, Tableflow, Telemetry). Predicates in `connection-predicates.ts` express those checks as pure functions; `connectionIdsWhere(connections, predicate)` walks `runtime.config.connections` and returns the matching ids.

- A tool whose predicate matches zero connections is automatically disabled.
- A tool with no service-specific requirement (a rare case) returns `Object.keys(runtime.config.connections)` directly.
- Cloud-only-ness is expressed as `hasConfluentCloud` (or a conjunction like `hasCCloudCatalogSupport`), not a separate boolean override.
- New predicates should be additive and pure; they read the YAML/config shape only.

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
  import { ClientManager } from "@src/confluent/client-manager.js";
  import { CallToolResult } from "@src/confluent/schema.js";
  import {
    BaseToolHandler,
    READ_ONLY,
    ToolConfig,
  } from "@src/confluent/tools/base-tools.js";
  import {
    connectionIdsWhere,
    hasSchemaRegistry,
  } from "@src/confluent/tools/connection-predicates.js";
  import { ToolName } from "@src/confluent/tools/tool-name.js";
  import { ServerRuntime } from "@src/server-runtime.js";
  import { z } from "zod";
  ```
- For a handler that extends a domain subclass, drop `BaseToolHandler`, the predicate imports, and `ServerRuntime` (the subclass owns those):
  ```typescript
  import { ClientManager } from "@src/confluent/client-manager.js";
  import { CallToolResult } from "@src/confluent/schema.js";
  import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
  import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
  import { ToolName } from "@src/confluent/tools/tool-name.js";
  import { z } from "zod";
  ```
