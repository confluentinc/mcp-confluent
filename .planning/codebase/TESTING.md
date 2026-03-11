# Testing Patterns

**Analysis Date:** 2026-03-11

## Test Framework

**Status:** No automated unit/integration test framework configured

**Type Checking:**
- Runner: TypeScript compiler (tsc)
- Config: `tsconfig.json` with `strict: true`
- Run command: `npm run test:ts` (type checking only, no emit)
- Purpose: Catch type errors before runtime

**Note:** Testing is currently limited to type checking. No Jest, Vitest, Mocha, or other test runners are configured.

## Testing Approach

**Current Strategy:**
- Rely on TypeScript strict mode type safety
- Manual testing and inspection via MCP Inspector
- ESLint for code quality rules
- Prettier for consistent formatting

**Manual Testing Tool:**
```bash
npm run inspector
# Opens MCP Inspector for manual interaction with tools
```

**Build/Runtime Validation:**
```bash
npm run build
# Compiles TypeScript and resolves path aliases
# Failures indicate type or runtime issues
```

## Validation Patterns

**Input Validation (Zod Schemas):**
- All handler input validated with Zod schemas
- Schema parsing throws on invalid input: `arguments.parse(toolArguments)`
- Zod used for tool configuration validation
- Example from `src/confluent/tools/handlers/kafka/list-topics-handler.ts`:
```typescript
const listTopicArgs = z.object({
  // No arguments
});

export class ListTopicsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    // Schema auto-validates - would throw if invalid
    const {} = listTopicArgs.parse(toolArguments);
    // ... handler logic
  }
}
```

**Parameter Validation:**
- `getEnsuredParam()` helper validates required environment variables
- Throws `Error` with descriptive message if parameter missing
- Location: `src/confluent/helpers.ts`
- Example:
```typescript
const organization_id = getEnsuredParam(
  "FLINK_ORG_ID",
  "Organization ID is required",
  organizationId,
);
```

**Schema Registry Validation:**
- `checkSchemaNeeded()` validates schema existence before produce/consume
- Returns `SchemaCheckResult` with schema details or error state
- Handlers check result and return error responses: `if (valueSchemaResult) return valueSchemaResult`
- Location: `src/confluent/schema-registry-helper.ts`

## Error Handling Patterns

**Handler Error Responses:**
- All handler errors return `CallToolResult` with `isError: true`
- Never throw uncaught exceptions; catch and format for client
- Error messages include context: API responses, serialization failures, missing data

**Try-Catch Patterns:**
- Wrap async operations that may fail:
```typescript
try {
  valueToSend = await serializeMessage(
    topicName,
    value as MessageOptions,
    SerdeType.VALUE,
    registry,
  );
} catch (err) {
  return this.createResponse(
    `Failed to serialize: ${err instanceof Error ? err.message : err}`,
    true,
  );
}
```

**OpenAPI Client Errors:**
```typescript
const { data: response, error } = await pathBasedClient[
  "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements"
].POST({
  // ... request body
});
if (error) {
  return this.createResponse(
    `Failed to create Flink SQL statements: ${JSON.stringify(error)}`,
    true,
  );
}
```

**Logger Error Handling:**
- Errors logged with context object:
```typescript
logger.error({ err: error }, "Error starting server");
logger.error({ error }, "Environment validation error");
```

## Environment Configuration Testing

**Environment Validation:**
- All env vars validated via Zod schema (`src/env-schema.ts`)
- Missing critical variables cause startup failure
- File: `src/env.ts` performs validation and logs errors

**Tool Requirement Validation:**
- Each handler implements `getRequiredEnvVars(): EnvVar[]`
- Tools automatically disabled if required env vars missing
- Examples in handlers:
```typescript
// src/confluent/tools/handlers/kafka/list-topics-handler.ts
getRequiredEnvVars(): EnvVar[] {
  return ["KAFKA_API_KEY", "KAFKA_API_SECRET", "BOOTSTRAP_SERVERS"];
}

// src/confluent/tools/handlers/flink/create-flink-statement-handler.ts
getRequiredEnvVars(): EnvVar[] {
  return ["FLINK_API_KEY", "FLINK_API_SECRET"];
}
```

**Confluent Cloud Only Validation:**
- Handlers that require Confluent Cloud override `isConfluentCloudOnly()`
- Example:
```typescript
isConfluentCloudOnly(): boolean {
  return true;
}
```

## Manual Testing Scenarios

**Type Checking:**
```bash
npm run test:ts
# Validates all TypeScript compiles without errors
```

**Linting:**
```bash
npm run lint
# Check code quality rules via ESLint
```

**Auto-fix Issues:**
```bash
npm run lint:fix
npm run format
# Fix automatically fixable issues
```

**Build Testing:**
```bash
npm run build
# Full compilation: tsc && tsc-alias
# Validates path alias resolution and type safety
```

**Development Watch Mode:**
```bash
npm run dev
# Runs tsc --watch and tsc-alias --watch
# Continuously validates code during development
```

**Runtime Testing:**
```bash
npm start
# Starts the server with default stdio transport
# Manually invoke tools via MCP client (Claude Desktop)
```

**API Key Testing:**
```bash
npx @confluentinc/mcp-confluent --generate-key
# Validates API key generation works correctly
```

## Handler Test Patterns

**Handler Structure (Testable):**
- All handlers follow consistent interface from `BaseToolHandler`
- `handle()` method accepts typed arguments
- `getToolConfig()` returns static configuration
- `getRequiredEnvVars()` declares dependencies
- `isConfluentCloudOnly()` indicates scope

**Handler Composition (Testable):**
- Handlers accept `ClientManager` for dependency injection
- Handlers use helper functions for shared logic
- Example helper functions that could be unit tested:
  - `executeFlinkSql()` in `src/confluent/tools/handlers/flink/flink-sql-helper.ts`
  - `checkSchemaNeeded()` in `src/confluent/schema-registry-helper.ts`
  - `deserializeMessage()` in `src/confluent/schema-registry-helper.ts`

**Response Validation (Testable):**
- All handlers return `CallToolResult` with consistent structure
- Response includes `content` array with text
- Error responses set `isError: true`
- Optional `_meta` for additional data
```typescript
const response: CallToolResult = {
  content: [{ type: "text", text: message }],
  isError: isError,
  _meta: _meta,
};
```

## Client Manager Testing

**Interface-Based Design (Testable):**
- `ClientManager` interface splits concerns:
  - `KafkaClientManager`: Kafka client operations
  - `ConfluentCloudRestClientManager`: Confluent Cloud REST clients
  - `SchemaRegistryClientHandler`: Schema Registry operations
- Clients initialized lazily via `AsyncLazy` wrapper
- Setters allow endpoint override: `setConfluentCloudFlinkEndpoint()`

**Dependency Injection Ready:**
- Handlers depend on interface, not implementation
- Could mock `ClientManager` in tests
- Lazy initialization allows test setup without side effects

## Coverage Gaps

**No Test Files Present:**
- No `.test.ts` or `.spec.ts` files in the codebase
- No `__tests__` directories
- No test configuration (Jest, Vitest, etc.)

**Untested Areas:**
- Handler logic for success paths (only type-checked)
- Error handling in handlers (validated manually)
- Client manager initialization and cleanup
- Transport layer (stdio, HTTP, SSE)
- Authentication middleware
- OpenAPI client generation and usage
- Kafka message serialization edge cases
- Schema Registry interactions
- Flink SQL execution results

**Testing Recommendations:**
- Add unit tests for handler `handle()` methods with mocked `ClientManager`
- Test input validation with invalid Zod schemas
- Test error response formatting
- Test environment variable validation
- Test client manager lazy initialization
- Test transport layer message handling
- Integration tests with real Confluent Cloud APIs (if possible)

---

*Testing analysis: 2026-03-11*
