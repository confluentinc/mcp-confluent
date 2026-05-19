## `list-consumer-groups` tool

Smallest of the consumer-group analysis tools planned under #488.
Wraps `admin.listGroups()` on the native Kafka admin client to enumerate consumer groups on a cluster.

- Predicate `kafkaBootstrapOrOAuth` (same as `consume-messages`, `produce-message`, `list-topics`).
- Category `ToolCategory.Kafka`; annotation `READ_ONLY`.
- Optional `matchStates` (non-empty array of state names) and `matchType` (scalar `Classic` | `Consumer`) save callers a client-side filter pass.
- Standard `cluster_id` / `environment_id` optional args for OAuth connections.

`matchType` is wrapped in a single-element array before being passed through as `matchConsumerGroupTypes`; the underlying `admin.listGroups` accepts an array there but the tool surface deliberately exposes a scalar, since the two-value enum makes a multi-select either redundant or degenerate.

The state and type names surfaced on the response are the TitleCase forms (`Stable`, `Empty`, `Classic`, `Consumer`, …), not the `SCREAMING_SNAKE_CASE` rdkafka enum-key spellings.
librdkafka returns numeric enum values; a forward map translates the Zod-validated input names to numerics on the way in, and a reverse map translates back on the way out.
`Object.values(ConsumerGroupStates)` is intentionally not used — TypeScript's reverse-mapping of numeric enums returns both names and numbers, which Zod would reject.

## `structuredContent` first-mover (alongside `get-partition-offsets`)

This tool surfaces its machine-readable payload via MCP's `structuredContent` channel (per the [2025-11-25 spec](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)).
Adds `BaseToolHandler.createStructuredResponse(text, structured)` next to the existing `createResponse` — additive, no existing handler changes shape.
The text content keeps its human-readable summary role; the broader migration is tracked in #435.

This branch and `feat/480-get-partition-offsets` (still pre-PR) each introduce the same helper independently; whichever lands first wins and the loser drops its copy on rebase.

Wire-format payload:

```typescript
type ListConsumerGroupsResponse = {
  groups: Array<{
    groupId: string;
    state: string;
    type: string;
    protocolType: string;
    isSimpleConsumerGroup: boolean;
  }>;
  errors: Array<{ message: string; code?: number }>;
};
```

Text summary is `Found N consumer group(s).` plain, or `Found N consumer group(s) (filtered).` when any filter is in play.
The original spec carried an `on cluster <id>` clause; dropped because `resolveKafkaClusterArgs` returns `undefined` for direct connections, and the structured payload already carries everything machine-readable.

## Partial- vs total-failure shape

`admin.listGroups` returns `{groups, errors}` where `errors` carries per-broker `LibrdKafkaError` entries surfaced as non-fatal partial failures.
The handler surfaces them verbatim through the `errors` field of the structured payload — partial successes are not collapsed into a tool-level error.

Total failure (`groups: []` and `errors` populated) returns a tool-level `isError: true` response whose text cites the first broker error message.

## Relationships

Closes #489.
Child of #488 (consumer-group analysis tooling).
Independent of `describe-consumer-group` and `get-consumer-group-lag` (sibling issues under #488), but lands first so the other two can use its output during integration tests to find real group IDs.
