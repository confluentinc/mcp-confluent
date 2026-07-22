---
paths:
  - src/**/*.ts
---

# Logging with Pino: errors go under the `err` key, context goes in fields

The project logs through Pino (`@src/logger.js`).
Pino registers a **serializer for the `err` key by default** — pass an error there and it extracts `message`, `type`, and the full `stack`.
That serializer keys off the property name: an error logged under any other key (`error`, `e`, `cause`) is serialized as a plain object, so its stack is lost.

## The rule

When a log call reports a failure, pass the caught value under `err`, and put every other identifier (ids, status codes, names, URLs) in its own field on the same context object.
The message string is a static human label, not a place to interpolate the error.

```typescript
// Good: err captures the stack; status/kind are filterable fields.
logger.warn(
  { err, status: result.response?.status, kind },
  "Telemetry API descriptors request failed; omitting best-effort section",
);
logger.error({ err }, "Error in ListMetricsHandler");
```

```typescript
// Bad: no stack (wrong key), and the error is welded into the message so it
// can't be filtered or parsed downstream.
logger.warn(`Telemetry API error (HTTP ${status}): ${describeError(err)}`);
logger.error({ error }, "Error in ListMetricsHandler"); // `error` ≠ `err`
```

`err` may hold a value typed `unknown` (a `catch` binding, an `openapi-fetch` `error` payload).
Pino serializes a non-`Error` under `err` fine — it just has no stack to add — so there is no need to narrow to `Error` before logging.
Reference calls that already follow this: `src/confluent/oauth/pkce-login.ts` and `src/confluent/tools/cluster-arg-resolvers.ts`.

## Don't test the log

Logging is a side effect, not observable behaviour — do not stub the logger or assert on log shape.
This mirrors the standing guidance in `.claude/rules/unit-tests.md` ("Do not test or stub side effects like logging").
Get the `err`-key convention right by reading, not by pinning it in a test.

## Migration note

Some historical call sites still log under `error` (e.g. a few in `src/confluent/tools/handlers/docs/`).
They pre-date this rule and are harmless but lose the stack.
Convert them to `err` opportunistically when you're already editing the surrounding code, not as a standalone sweep.
