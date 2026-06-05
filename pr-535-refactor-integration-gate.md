# Integration tests gate via `handler.predicate(integrationConnection())`

## Relationships

- Closes #535.
- Child of #532 (Epic: Multi-connection support).
  See "Why this is a step toward #532" below — the gating-idiom shift is a down-payment on the epic, not just adjacent test-debt cleanup.
- Enables #543 (new multi-connection integration test suite): #543's per-connection assertions are written in exactly the predicate-against-one-connection terms this PR establishes.
- Builds on #385 (the `predicate` property — the now-closed #288 migration), merged to `main`; that property is what these gates now evaluate.
- Narrows but does not close #289 — see "On #288 / #289" below.

## Why this is a step toward #532

The epic's core move is to stop treating "the connection" as a singular and start asking per-connection questions: which of several connections a tool routes to, and which connections it is even enabled on.
The integration-test gating was quietly anchored to the old singular model — `handler.enabledConnectionIds(integrationRuntime()).length === 0` builds a whole `ServerRuntime` and collapses enablement into a count across all (today: one) connections.
That's the wrong shape to carry into a multi-connection world: a count can't tell you _which_ connection a tool is enabled on.

This PR re-points the harness at the per-connection question: `handler.predicate(integrationConnection())` evaluates one predicate against one named `ConnectionConfig`.
That is the same primitive production routing runs on under #532, just exercised against a single-connection fixture for now.
The unit the harness reasons about is now a `ConnectionConfig`, not a whole-runtime count — and a `ConnectionConfig` is exactly what per-connection assertions are written against, whereas a count has nothing to generalize.

Concretely, this is the groundwork #543 (the two-cluster suite) builds on:

- "A Flink tool auto-routes because only the Flink-capable connection satisfies `hasFlink`" becomes a pair of per-connection predicate checks (`handler.predicate(connB).enabled` true, `handler.predicate(connA).enabled` false) — not a runtime-wide count.
- The skip/enablement decision already speaks in single-`ConnectionConfig` terms, so #543 extends the harness to per-connection fixtures rather than first having to unwind a runtime-count idiom that doesn't generalize.

So #535 converts the harness's mental model from "is this tool enabled on the runtime" to "is this tool enabled on this connection" — the same shift #532 makes in production code — before #543 has to assert in those terms against live infrastructure.

## On #288 / #289

#288 (fold per-handler `enabledConnectionIds` overrides into a `predicate` property) is already closed — it landed as #385.
This PR is a _consumer_ of that property, not a re-implementation, so it does not close #288.

#289 (derive predicate `configPath` strings from typed accessors via a `Proxy`, so skip messages auto-track schema-field renames) is **not** implemented here.
Instead, skip reasons now come from the predicate's `ToolDisabledReason` — one enum shared by startup logs, diagnostics, and these tests.
That collapses the drift surface #289 targeted (one maintained phrase per reason, colocated with the predicates, versus ~50 hand-typed strings scattered across test files) and delivers the payoff #288 anticipated ("skip messages can collapse from literal strings").
It does **not** deliver #289's mechanism: renaming a schema field still won't auto-propagate into the `ToolDisabledReason` text.
So this PR leaves #289 open, narrowed to "is the Proxy-derived path still worth building now that the per-test strings are gone?" — a call for the epic owners, not this PR.

## The gating seam

- Integration tests now gate on a single helper call — `if (skipIfNotEnabled(handler, integrationConnection())) return;` — instead of `handler.enabledConnectionIds(integrationRuntime()).length === 0`.
  A fixture holds exactly one connection, so a single `ConnectionConfig` is the right-sized input for a predicate — there's no reason to build a whole `ServerRuntime` to ask an enablement question.
- The skip reason defaults to the verdict's `ToolDisabledReason`, so a misconfigured fixture reports the precise missing block (e.g. `"'kafka' block does not have 'bootstrap_servers' field"`) rather than a hand-maintained label that could drift from the predicate.
  Gates needing an actionable message the verdict can't express pass an explicit reason as the helper's third arg (see below).
- Every `enabledConnectionIds`-based gate across the `*.integration.test.ts` suite is converted; a grep for `enabledConnectionIds(` in integration tests now returns zero.

## New harness helpers

- `skipIfNotEnabled(handler, conn, reasonOverride?): boolean` in `tests/harness/skip-gate.ts` — the one-line gate every predicate-gated test now uses.
  It runs the handler's predicate against `conn` and, when disabled, calls `it.skip` (registered at collection time against the calling suite) and returns `true`, so the gate reads as `if (skipIfNotEnabled(...)) return;`.
  The reason defaults to the verdict's `ToolDisabledReason`; `reasonOverride` serves the keep-constant gates below.
- `integrationConnection({ oauth? }): ConnectionConfig` and `integrationConnectionLoaded({ oauth? }): boolean` in `tests/harness/runtime.ts`, over a shared private `tryIntegrationConnection` loader.
  `integrationConnection` returns the fixture's sole connection (empty `direct` on load failure, so the predicate yields a clean disabled verdict); `integrationConnectionLoaded` is the existence check the transport smoke tests use.
- `cpIntegrationConnection(): ConnectionConfig` in `tests/harness/cp-runtime.ts` — the Confluent Platform peer, reading `integration.cp.yaml`.
- `integrationRuntime()` stays: the seeding harness helpers (kafka-admin, schema-registry, flink, connect, confluent-cloud) still build a runtime to read per-connection config for their api-key-authed clients, and a handful of tests read `getSoleDirectConnection()` in their bodies. Its docstring's stale "tests gate via this" paragraph is rewritten to its real surviving purpose.

## Gates that keep an explicit reason (condition-swapped only)

Some gates carry a reason the generic verdict can't express; these pass it as `skipIfNotEnabled`'s `reasonOverride` (or, for the connection-existence smoke gates, use `integrationConnectionLoaded`):

- Transport smoke tests (`auth`, `multi-client`) and the OAuth-flow smoke test (`ccloud-oauth`): "did any connection load?" → `integrationConnectionLoaded(...)` (no handler predicate involved).
- OAuth-describe and OAuth-seeding gates in dual-mode tests: `reasonOverride` of `OAUTH_FIXTURE_NOT_LOADED_REASON` / `DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON`.
- Confluent Platform (`*.cp.integration.test.ts`) gates: `reasonOverride` of their docker-compose + `CP_KAFKA_*` setup-runbook string — actionable local-setup guidance no `ToolDisabledReason` carries.

## Docs

- `.claude/rules/integration-tests.md` updated in every spot that taught the old idiom: Canonical Test Structure, Credential Gating by Tool Domain (dropping the obsolete hand-typed-label table, since skip reasons now come from the predicate's `ToolDisabledReason`), the dual-mode template, and the OAuth-seeding gate.

## Proof

- `npx tsc --noEmit` clean; `eslint` clean on all changed files.
- `tests/harness/skip-gate.test.ts` proves the helper both ways: enabled → returns `false` (no skip); disabled → returns `true` and registers a skipped placeholder, which the run surfaces (one named after the verdict reason, one after a `reasonOverride`) — confirming `it.skip` called from an imported helper lands on the calling suite with the right text.
- `npx vitest list --project integration` collects all 420 integration cases (exit 0) — every converted describe body evaluates its gate without error, whether it skips (creds absent) or registers transport variants (creds present).
- A full `npm run test:integration` (build + live CCloud) is the CI-side confirmation that gates skip/run as before; the conversion is behaviour-preserving (same predicate, same connection source).

## Scope

- ~57 `*.integration.test.ts` files, three harness modules (`runtime.ts`, `cp-runtime.ts`, and the new `skip-gate.ts` with its `skip-gate.test.ts`), and the rule doc.
- Five files (`add-tags-to-topic`, `remove-tag-from-entity`, `connector-lifecycle`, `describe-table`, `get-table-info`) keep `integrationRuntime` for body-level `getSoleDirectConnection()` reads that #535 doesn't target; only their `enabledConnectionIds` gate is converted. Those `getSoleDirectConnection()` field-precondition gates are left as-is — they aren't the `enabledConnectionIds` idiom this issue retires.
