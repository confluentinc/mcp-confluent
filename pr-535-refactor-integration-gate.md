# Integration tests gate via `handler.predicate(integrationConnection())`

## Relationships

- Closes #535.
- Child of #532 (Epic: Multi-connection support) — lands the clean gating idiom the future multi-connection integration tests (#543) will follow.
- Realizes the #288 / #289 cleanup: the hand-typed per-test skip-reason strings are gone, derived from the predicate's `ToolDisabledReason` instead.
- Built on #385 (the `predicate` property), merged to `main`.

## The gating seam

- Integration tests now gate on `handler.predicate(integrationConnection())` instead of `handler.enabledConnectionIds(integrationRuntime()).length === 0`.
  A fixture holds exactly one connection, so a single `ConnectionConfig` is the right-sized input for a predicate — there's no reason to build a whole `ServerRuntime` to ask an enablement question.
- The skip reason is now the verdict's `ToolDisabledReason` (`it.skip(verdict.reason, …)`), so a misconfigured fixture reports the precise missing block (e.g. `"'kafka' block does not have 'bootstrap_servers' field"`) rather than a hand-maintained label that could drift from the predicate.
- Every `enabledConnectionIds`-based gate across the `*.integration.test.ts` suite is converted; a grep for `enabledConnectionIds(` in integration tests now returns zero.

## New harness helpers

- `integrationConnection({ oauth? }): ConnectionConfig` and `integrationConnectionLoaded({ oauth? }): boolean` in `tests/harness/runtime.ts`, over a shared private `tryIntegrationConnection` loader.
  `integrationConnection` returns the fixture's sole connection (empty `direct` on load failure, so the predicate yields a clean disabled verdict); `integrationConnectionLoaded` is the existence check the transport smoke tests use.
- `cpIntegrationConnection(): ConnectionConfig` in `tests/harness/cp-runtime.ts` — the Confluent Platform peer, reading `integration.cp.yaml`.
- `integrationRuntime()` stays: the seeding harness helpers (kafka-admin, schema-registry, flink, connect, confluent-cloud) still build a runtime to read per-connection config for their api-key-authed clients, and a handful of tests read `getSoleDirectConnection()` in their bodies. Its docstring's stale "tests gate via this" paragraph is rewritten to its real surviving purpose.

## Gates that keep an explicit reason (condition-swapped only)

Some gates use `enabledConnectionIds` only as a proxy and carry a reason the generic verdict can't express; these swap the condition to the predicate form but keep their explicit reason:

- Transport smoke tests (`auth`, `multi-client`) and the OAuth-flow smoke test (`ccloud-oauth`): "did any connection load?" → `integrationConnectionLoaded(...)`.
- OAuth-describe and OAuth-seeding gates in dual-mode tests: keep `OAUTH_FIXTURE_NOT_LOADED_REASON` / `DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON`.
- Confluent Platform (`*.cp.integration.test.ts`) gates: keep their docker-compose + `CP_KAFKA_*` setup-runbook string — actionable local-setup guidance no `ToolDisabledReason` carries.

## Docs

- `.claude/rules/integration-tests.md` updated in every spot that taught the old idiom: Canonical Test Structure, Credential Gating by Tool Domain (including dropping the obsolete hand-typed-label table — the #288/#289 "future cleanup" this PR lands), the dual-mode template, and the OAuth-seeding gate.

## Proof

- `npx tsc --noEmit` clean; `eslint` clean on all changed files.
- `npx vitest list --project integration` collects all 420 integration cases (exit 0) — every converted describe body evaluates its gate without error, whether it skips (creds absent) or registers transport variants (creds present).
- A full `npm run test:integration` (build + live CCloud) is the CI-side confirmation that gates skip/run as before; the conversion is behaviour-preserving (same predicate, same connection source).

## Scope

- 57 `*.integration.test.ts` files + 2 harness modules + the rule doc.
- Five files (`add-tags-to-topic`, `remove-tag-from-entity`, `connector-lifecycle`, `describe-table`, `get-table-info`) keep `integrationRuntime` for body-level `getSoleDirectConnection()` reads that #535 doesn't target; only their `enabledConnectionIds` gate is converted. Those `getSoleDirectConnection()` field-precondition gates are left as-is — they aren't the `enabledConnectionIds` idiom this issue retires.
