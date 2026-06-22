---
paths:
  - src/config/**/*.ts
  - src/confluent/tools/**/*.ts
  - tests/harness/**
  - tests/factories/**
---

# Connection nomenclature: configured connections have IDs, not names

A configured connection is addressed by its **id**.
The id is the key under the `connections:` map in YAML, and it is the same value a caller passes as the `connectionId` tool argument to route a call — the map key and the routing id are one and the same thing.
There is no separate "connection name" concept; do not introduce one.

## The rule

Every identifier, constant, method, parameter, Zod message, docstring, test title, log line, and user-facing string that refers to a configured connection's key must say **id**, never **name**.
Concretely: `connectionId` (camelCase parameters/fields), `*ConnectionId` / `ConnectionId` (types), `*_CONNECTION_ID` (SCREAMING_CASE constants), `getConnectionIds()` (accessors), and "connection id" in prose.

This was decided in #556: a survey found `id`-form identifiers outnumbered `name`-form ones roughly 225 to 22, and — more decisively — the user-facing surface already speaks `id` (the injected `connectionId` tool argument, `MCPServerConfiguration.getConnectionConfig(connectionId)`, `getConnectionIds()`, and the README's "connection id").
`name` lost; do not reintroduce it.

## The one legitimate "connection_name"

`connection_name` in the generated `src/confluent/openapi-schema.d.ts` is the **Flink SQL `CONNECTION` object** — a distinct Confluent domain concept that has nothing to do with the MCP server's connection keys.
Leave it alone, never hand-edit generated types, and never conflate a Flink `CONNECTION` with an MCP connection id.

## When you add or rename

Name any new connection-key identifier, constant, argument, message, or doc with `id` from the start.
Before claiming a connection rename or addition is complete, sweep case-insensitively — `grep -rin "connection name"` plus a `CONNECTION_NAME` / `connectionName` identifier grep — because a case-sensitive camelCase grep silently misses `SCREAMING_CASE` constants and space-separated prose.

If two modules legitimately need same-named connection-id constants with different values (e.g. the production env-var synthesis id `"_default"` in `src/config/env-config.ts` versus the test-fixture id `"default"` in `tests/factories/runtime.ts`), state the distinction in both docstrings and cross-reference them so the collision reads as deliberate rather than as a trap.
