import type { ConnectionConfig } from "@src/config/models.js";
import type { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { it } from "vitest";

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
  it.skip(reasonOverride ?? verdict.reason, () => {});
  return true;
}
