# PR #359 — Enable native Kafka tools under OAuth

## Summary of Changes

- **Light up the five native Kafka tools under OAuth** — `list-topics`, `create-topics`, `delete-topics`, `produce-kafka-message`, `consume-kafka-messages`. Each accepts `cluster_id` + `environment_id` tool args (required under OAuth, ignored under direct).

- **SASL/OAUTHBEARER race fixed at the source.** The kafkaJS-compat `async` `oauthBearerProvider` resolves on the microtask queue and races librdkafka's SASL state machine, which previously caused the first metadata fetch to hang to its full request timeout. Switching to librdkafka's **synchronous** `oauthbearer_token_refresh_cb` eliminates the race entirely — the previous `try { listTopics(5s) } catch { listTopics(30s) }` warmup retry workaround is gone. _(A different one-shot `admin.listTopics()` warmup remains — see below.)_

- **Per-call client lifecycle, caller-owned.** OAuth handlers build a fresh `KafkaJS.Kafka` per tool call and dispose via `try { ... } finally { await disposeIfOAuth(runtime, connId, client) }`. `disposeIfOAuth` is a no-op on direct (`AsyncLazy` singletons stay manager-owned). The previous `ClientCache<K,V>` substrate with idle-timeout eviction is deleted.

- **Metadata warmup for the OAuth admin path** (separate problem from the SASL race). `admin.connect()` returns before librdkafka has discovered the controller broker, and `createTopics`/`deleteTopics` time out locally on first use without it. A single `admin.listTopics()` after `connect()` primes the broker map. Costs ~50–200ms per OAuth admin call.

- **OAuth refresh-loop drift fixed.** `AuthContext`'s loop is rewritten from a fixed-cadence `setInterval` to a self-rescheduling `setTimeout` keyed off `controlPlaneExpiresAt - REFRESH_WINDOW_MS`. The original design drifted past the refresh window every cycle (auth0 latency shifted CP_expires forward of the tick schedule), leaving the CP token expired and unrefreshed for ~4 minutes per cycle — repro: tool succeeds, idle ~10–15 min, second call fails with `OAuth token is not currently available`. A non-transient-error guard stops the loop cleanly instead of hammering auth0 forever on a permanent failure.

- **Adapt to PR #369's `PredicateResult` API.** Five Kafka handlers' `enabledConnectionIds` switch from the broken `(c) => hasKafkaBootstrap(c) || isOAuth(c)` (object-typed predicates can't compose with `||`) to a new `widenForOAuth(hasKafkaBootstrap)` helper. Predicate defaults stay strict; OAuth-capable handlers opt in per-site. Direct answer to the reviewer comment on #369.

- **`formatKafkaError(err)` consolidates Kafka-error rendering** for `create-topics` (per-topic-cause unwrap from `KafkaJSAggregateError`), `produce`, and `consume`. `list-topics` and `delete-topics` keep throw-and-propagate (deliberate — read ops let MCP surface; write/aggregate-prone ops format inline).

- **Schema Registry under OAuth deferred.** `produce`/`consume` return a clear capability error when `useSchemaRegistry: true` is requested under OAuth. The SR SDK accessor and endpoint resolver stay in place ready for the follow-up that adds `list-schema-registry-clusters`. The accessor itself now waits for `holder.bootstrapPromise` and rejects an empty DPAT (mirrors the Kafka-side guard) so the path doesn't bake an empty `Bearer ` into axios headers when called during initial login.

- **`list-clusters` reverted to main.** It's a REST tool, not native Kafka. OAuth-capable `list-clusters` is its own concern.

Fixes #313

## Manual Testing

Build the server (`npm run build`), then create `oauth.yaml` at the project root:

```yaml
connections:
  ccloud-oauth:
    type: oauth
    ccloud_env: prod # or `devel` / `stag`
```

Register with Claude Code MCP:

```sh
claude mcp add mcp-confluent-oauth -- node ./dist/index.js -c ./oauth.yaml
```

Have the agent exercise the five native-Kafka tools against a throwaway topic (passing `cluster_id` + `environment_id`):

1. `list-topics` → topic list.
2. `create-topics` → success. Re-run with same name → "One or more topics already exist".
3. `produce-kafka-message` → offset metadata.
4. `consume-kafka-messages` → message just produced.
5. `delete-topics` → success.

Edge cases:

6. Call `list-topics` without `cluster_id`/`environment_id` → "cluster_id and environment_id are required under --oauth".
7. Call `produce-kafka-message` with `useSchemaRegistry: true` → "not yet supported under --oauth" capability error (no stack trace).
8. Idle ~10 min, then re-run a tool → succeeds (refresh-loop drift fix).

For direct-path regression, swap to a direct (api-key) YAML and re-register; behavior should be unchanged from main.

## Tests

- [x] Added: `oauth-client-manager.test.ts`, `cluster-arg-resolvers.test.ts`, `oauth-resource-resolvers.test.ts`
- [x] Updated: `auth-context.test.ts` (refresh-loop redesign), the five Kafka handler tests (OAuth-typed `enabledConnectionIds` case)
- [ ] Deleted: none
