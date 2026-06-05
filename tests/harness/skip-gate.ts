import type { ConnectionConfig } from "@src/config/models.js";
import type { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { it } from "vitest";

/**
 * Indirection over `it.skip` so {@linkcode skipIfNotEnabled}'s skip side effect
 * is spyable. Vitest's `it.skip` is a non-configurable property, so `vi.spyOn`
 * can't intercept it directly; spy on `skipReporter.skip` instead (the
 * node-deps namespace pattern from `.claude/rules/unit-tests.md`).
 */
export const skipReporter = {
  skip(reason: string): void {
    it.skip(reason, () => {});
  },
};

/**
 * Integration-test skip gate. Returns `true` — after registering a skipped
 * placeholder via `it.skip` — when `handler` is not enabled for `conn`, so a
 * gate reads as a one-liner: `if (skipIfNotEnabled(handler, integrationConnection())) return;`.
 *
 * Call it at describe-body scope (collection time), where `it.skip` is valid;
 * the caller keeps the `return` so the rest of the describe body is skipped.
 *
 * Incorporates the call to `it.skip()` so the caller doesn't have to -- callers just
 * return if this returns true.
 *
 * The skip reason defaults to the predicate verdict's {@linkcode ToolDisabledReason}.
 * Pass `reasonOverride` for gates whose precondition the generic verdict can't
 * express — the OAuth fixture/seeding gates and the Confluent Platform setup runbook.
 */
export function skipIfNotEnabled(
  handler: ToolHandler,
  conn: ConnectionConfig,
  reasonOverride?: string,
): boolean {
  const verdict = handler.predicate(conn);
  if (verdict.enabled) return false;
  skipReporter.skip(reasonOverride ?? verdict.reason);
  return true;
}
