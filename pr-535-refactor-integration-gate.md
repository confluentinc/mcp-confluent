# Integration tests gate via `handler.predicate(integrationConnection())`

## Relationships

- Closes #535.
- Child of #532 (Epic: Multi-connection support) — lands the clean gating idiom the future multi-connection integration tests (#543) will follow.
- Realizes the #288 / #289 cleanup: the hand-typed per-test skip-reason strings are gone, derived from the predicate's `ToolDisabledReason` instead.
- Built on #385 (the `predicate` property), merged to `main`.

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

- `.claude/rules/integration-tests.md` updated in every spot that taught the old idiom: Canonical Test Structure, Credential Gating by Tool Domain (including dropping the obsolete hand-typed-label table — the #288/#289 "future cleanup" this PR lands), the dual-mode template, and the OAuth-seeding gate.

## Proof

- `npx tsc --noEmit` clean; `eslint` clean on all changed files.
- `tests/harness/skip-gate.test.ts` proves the helper both ways: enabled → returns `false` (no skip); disabled → returns `true` and registers a skipped placeholder, which the run surfaces (one named after the verdict reason, one after a `reasonOverride`) — confirming `it.skip` called from an imported helper lands on the calling suite with the right text.
- `npx vitest list --project integration` collects all 420 integration cases (exit 0) — every converted describe body evaluates its gate without error, whether it skips (creds absent) or registers transport variants (creds present).
- A full `npm run test:integration` (build + live CCloud) is the CI-side confirmation that gates skip/run as before; the conversion is behaviour-preserving (same predicate, same connection source).

## Scope

- ~57 `*.integration.test.ts` files, three harness modules (`runtime.ts`, `cp-runtime.ts`, and the new `skip-gate.ts` with its `skip-gate.test.ts`), and the rule doc.
- Five files (`add-tags-to-topic`, `remove-tag-from-entity`, `connector-lifecycle`, `describe-table`, `get-table-info`) keep `integrationRuntime` for body-level `getSoleDirectConnection()` reads that #535 doesn't target; only their `enabledConnectionIds` gate is converted. Those `getSoleDirectConnection()` field-precondition gates are left as-is — they aren't the `enabledConnectionIds` idiom this issue retires.
