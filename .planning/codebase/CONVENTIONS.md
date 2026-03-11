# Coding Conventions

**Analysis Date:** 2026-03-11

## Naming Patterns

**Files:**
- Kebab-case for file names: `list-topics-handler.ts`, `produce-kafka-message-handler.ts`, `create-tableflow-catalog-integration-handler.ts`
- Handler files consistently end with `-handler.ts` suffix
- Utility/helper files end with `-helper.ts`: `schema-registry-helper.ts`, `flink-sql-helper.ts`
- Resolver/factory files descriptive: `catalog-resolver.ts`, `tool-factory.ts`, `client-manager.ts`

**Enums:**
- UPPER_CASE with underscores for enum property names: `LIST_TOPICS`, `CREATE_TOPICS`, `DELETE_TOPICS`
- Enum values are kebab-case strings matching the key in lowercase with hyphens: `"list-topics"`, `"create-topics"`
- Example in `src/confluent/tools/tool-name.ts`:
  ```typescript
  export enum ToolName {
    LIST_TOPICS = "list-topics",
    CREATE_TOPICS = "create-topics",
    PRODUCE_MESSAGE = "produce-message"
  }
  ```

**Functions:**
- camelCase for function names: `handle()`, `getToolConfig()`, `getRequiredEnvVars()`, `createResponse()`
- Private/internal functions also camelCase: `getEnsuredParam()`, `executeFlinkSql()`, `deserializeMessage()`
- Async functions explicitly typed with `Promise<T>` return type

**Variables:**
- camelCase for variable and constant names: `clientManager`, `toolArguments`, `deliveryReport`
- Local constants in camelCase: `registry`, `valueSchemaCheck`, `keyToSend`
- Config objects with snake_case properties when mapping to external APIs: `organization_id`, `environment_id`, `compute_pool_id`

**Types and Interfaces:**
- PascalCase for type names: `ToolHandler`, `ToolConfig`, `BaseToolHandler`, `ClientManager`
- Type suffixes indicate purpose: `Manager` (management interface), `Handler` (implementation), `Config` (configuration object)
- Zod schema objects in camelCase: `createFlinkStatementArguments`, `produceKafkaMessageArguments`

**Classes:**
- PascalCase class names: `ListTopicsHandler`, `ProduceKafkaMessageHandler`, `ToolFactory`, `BaseToolHandler`
- Handler classes extend `BaseToolHandler` and follow pattern: `{Action}{Domain}Handler`
  - Examples: `CreateFlinkStatementHandler`, `ConsumeKafkaMessagesHandler`, `ListTableFlowCatalogIntegrationsHandler`

## Code Style

**Formatting:**
- Prettier 3.6.1 enforces consistent formatting (see `package.json`)
- No `.prettierrc` file present - uses Prettier defaults
- Line length: default (80 chars)
- Quotes: double quotes for TypeScript strings (Prettier default)
- Semicolons: required (Prettier default)

**Linting:**
- ESLint 9.29.0 with TypeScript ESLint parser and plugins
- Config file: `eslint.config.mjs` (flat config format)
- Includes recommended JS, TypeScript, and Prettier configs
- Auto-fix available via `npm run lint:fix`

**Prettier-ESLint Integration:**
- `eslint-config-prettier` disables ESLint rules that conflict with Prettier
- `eslint-plugin-prettier` runs Prettier as ESLint rule
- Format with: `npm run format` (runs Prettier on `**/*.+(js|ts|json)`)

## Import Organization

**Order:**
1. External dependencies first (node_modules): `import pino from "pino"`, `import { z } from "zod"`
2. Internal imports using path alias `@src/*`: `import { ClientManager } from "@src/confluent/client-manager.js"`
3. Grouped by module/domain within internal imports

**Path Aliases:**
- `@src/*` maps to `src/*` (defined in `tsconfig.json`)
- All internal imports use `@src/` prefix for clarity and maintainability
- Imports include `.js` extension for ESM compatibility: `.js` extension required

**Import Examples:**
```typescript
// External
import { z } from "zod";
import pino from "pino";

// Internal - grouped by domain
import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
```

## Error Handling

**Patterns:**
- Use try-catch blocks for async operations that may fail
- Throw `Error` with descriptive messages for missing required parameters
- Return error responses via `createResponse(message, true)` instead of throwing in handlers
- Check for undefined/null explicitly: `if (!finalParam)` before returning
- OpenAPI responses checked with destructuring: `const { data: response, error } = await pathBasedClient[...]`
- Instance checks for proper error handling: `if (err instanceof Error ? err.message : err)`

**Error Response Format:**
- Use `this.createResponse(message, isError)` from `BaseToolHandler`
- Second parameter `true` marks response as error
- Optional third parameter `_meta` for metadata: `{ latestSchema, subject, schemaType }`

**Examples from `src/confluent/tools/base-tools.ts`:**
```typescript
createResponse(
  message: string,
  isError: boolean = false,
  _meta?: Record<string, unknown>,
): CallToolResult {
  const response: CallToolResult = {
    content: [{ type: "text", text: message }],
    isError: isError,
    _meta: _meta,
  };
  return response;
}
```

## Logging

**Framework:** Pino 10.1.0

**Logger Setup:** (`src/logger.ts`)
- Main logger: `logger` exported as default, writes to stderr (fd 2)
- Structured logging with ISO timestamps: `pino.stdTimeFunctions.isoTime`
- Log level controlled by `LOG_LEVEL` env var (default: `info`)
- Logger name: `"mcp-confluent"`
- Kafka logging mapped to Pino levels via `createKafkaLogger()`

**Patterns:**
- `logger.info(object, message)`: `logger.info(`Shutting down...`)`
- `logger.warn(message)`: `logger.warn("Tool disabled due to allow/block list rules")`
- `logger.error(object, message)`: `logger.error({ err: error }, "Error starting server")`
- Use object first param for structured fields: `{ error }`, `{ args }`, `{ namespace }`
- Child loggers with namespace: `baseLogger.child({ namespace })`

**Log Levels:**
- Fatal: 60, Error: 50, Warn: 40, Info: 30, Debug: 20, Trace: 10
- Function `setLogLevel(level: LogLevel)` updates logger after env initialization

## Comments

**When to Comment:**
- Complex business logic requiring explanation
- Non-obvious API behavior or edge cases
- Workarounds for known issues with reasoning

**JSDoc/TSDoc:**
- Used extensively for public interfaces and abstract methods
- `@param` for parameter documentation
- `@returns` for return value documentation
- `@throws` for exceptions (rare in codebase)
- Example from `src/confluent/helpers.ts`:
```typescript
/**
 * Ensures a parameter exists either from the provided value or environment variable.
 * Favor the provided param over the environment variable when truthy.
 * @param envVarName - The name of the environment variable to check
 * @param errorMessage - The error message to throw if neither exists
 * @param param - Optional parameter value to use instead of environment variable
 * @returns The parameter value or environment variable value
 * @throws {Error} When neither parameter nor environment variable exists
 */
export const getEnsuredParam = <T extends Environment[keyof Environment]>(
  envVarName: keyof Environment,
  errorMessage: string,
  param?: T,
): T => { ... }
```

**Inline Comments:**
- Used for ESLint pragma disables: `// eslint-disable-next-line @typescript-eslint/no-unused-vars`
- Explain non-obvious constructor behavior: `// we need to do this since typescript will complain...`
- Document workarounds: `// only include the catalog and database properties if they are defined`

## Function Design

**Size:** Most handler methods 40-170 lines; longer ones break logic into helper functions

**Parameters:**
- Typed explicitly with specific types (not `any` unless unavoidable)
- Optional parameters use `?:` syntax: `sessionId?: string`
- Generic type parameters for reusable functions: `<T extends Environment[keyof Environment]>`

**Return Values:**
- Always explicitly typed: `Promise<CallToolResult>`, `ToolConfig`, `EnvVar[]`
- Zod schema parsing returns inferred types: `z.infer<typeof schema>`
- Async handlers return `Promise<CallToolResult> | CallToolResult` (supports both sync/async)

**Async/Await:**
- All async handler methods use `async handle()` signature
- Await on client operations: `await clientManager.getAdminClient()`
- Error handling with try-catch, return errors via `createResponse()`

## Module Design

**Exports:**
- Named exports for classes and functions: `export class ListTopicsHandler`, `export const getEnsuredParam`
- Type exports: `export type CallToolResult`, `export interface ToolHandler`
- Enum exports: `export enum ToolName`
- Default exports rare (used for `env` object in `src/env.ts`)

**Barrel Files:**
- Not used in this codebase; imports are direct from source files
- Each handler imported explicitly in `tool-factory.ts`

**Class Structure:**
- Handler classes implement/extend explicit interfaces
- Private fields use `#` prefix (not observed in this codebase; uses default access)
- Abstract methods in `BaseToolHandler` must be implemented: `abstract handle()`, `abstract getToolConfig()`
- Template methods provided: `createResponse()`, `getRequiredEnvVars()`, `isConfluentCloudOnly()`

## TypeScript Configuration

**Strict Mode Enabled:**
- `strict: true` in `tsconfig.json`
- `forceConsistentCasingInFileNames: true`
- `noUncheckedIndexedAccess: true`
- `noImplicitAny: false` (exception for OpenAPI schema typing issues)
- `resolveJsonModule: true` (for JSON imports if needed)

**Module System:**
- `module: "NodeNext"` for ESM support
- `moduleResolution: "nodenext"`
- ES2020+ target with `target: "ESNext"`

---

*Convention analysis: 2026-03-11*
