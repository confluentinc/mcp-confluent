import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import {
  PredicateResult,
  ToolDisabledReason,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";

/**
 * One bucket of disabled tools sharing a single {@linkcode ToolDisabledReason}
 * — the unit operators use to read the diagnostic surface ("what would I add
 * to the connection config to unlock these tools?"). Tool order within
 * `tools` follows the order handlers were iterated.
 */
export interface DisabledToolsByReason {
  readonly reason: ToolDisabledReason;
  readonly tools: readonly ToolName[];
}

/**
 * Output of {@linkcode buildToolGatingReport}; drives the
 * `explain-disabled-tools` diagnostic tool. Tools advertised via
 * `tools/list` are intentionally absent — the report carries the
 * negative signal only.
 *
 * Single-connection scope today (the server enforces one connection; see
 * `enforceSingleConnectionOnly()` in `src/config/models.ts`). When
 * multi-connection support lands as part of issue #151's follow-ups the
 * shape regrows around connections — per-connection sections plus a
 * cross-connection-deltas section calling out tools enabled on some
 * connections but not others.
 */
export interface ToolGatingReport {
  readonly disabledGroups: readonly DisabledToolsByReason[];
  readonly enabledCount: number;
  readonly disabledCount: number;
}

/**
 * One bucket of tools sharing the same `(connectionId, reason)` pair — the
 * unit of one grouped log line at server startup. `toolNames` preserves
 * input iteration order.
 */
export interface DisabledToolGroup {
  readonly connectionId: string;
  readonly reason: ToolDisabledReason;
  readonly toolNames: ToolName[];
}

/**
 * Group fully-disabled tools by `(connectionId, reason)`. A tool is "fully
 * disabled" when every configured connection reports a non-enabled verdict;
 * tools enabled on at least one connection are omitted entirely (they are
 * already going to be advertised by the server, so they don't belong in a
 * disabled-tool log line).
 *
 * Returned groups are sorted lexicographically by `connectionId`. Stable
 * sort preserves the relative order of groups within the same connection.
 */
export function groupDisabledToolsByReason(
  handlers: Iterable<readonly [ToolName, ToolHandler]>,
  runtime: ServerRuntime,
): DisabledToolGroup[] {
  const groups = new Map<string, DisabledToolGroup>();
  for (const [toolName, handler] of handlers) {
    const verdicts = handler.connectionVerdicts(runtime);
    // Single pass over the verdicts: collect disabled entries, abort on
    // the first enabled one (the tool is partially-enabled and doesn't
    // belong in a disabled-tool group).
    const disabledEntries: Array<readonly [string, ToolDisabledReason]> = [];
    let partiallyEnabled = false;
    for (const [connectionId, verdict] of verdicts) {
      if (verdict.enabled) {
        partiallyEnabled = true;
        break;
      }
      disabledEntries.push([connectionId, verdict.reason]);
    }
    if (partiallyEnabled) continue;

    for (const [connectionId, reason] of disabledEntries) {
      const key = `${connectionId}::${reason}`;
      let group = groups.get(key);
      if (!group) {
        group = { connectionId, reason, toolNames: [] };
        groups.set(key, group);
      }
      group.toolNames.push(toolName);
    }
  }
  return Array.from(groups.values()).sort((a, b) =>
    a.connectionId.localeCompare(b.connectionId),
  );
}

/**
 * Assemble a {@linkcode ToolGatingReport} for the given handler set against
 * the configured connection.
 *
 * v1 (single-connection scope):
 * - `disabledGroups` is sorted lex by reason; tools within a group follow
 *   handler iteration order.
 * - Each tool contributes once to `enabledCount` *or* `disabledCount`:
 *   a tool whose predicate produces an `enabled: true` verdict on at
 *   least one configured connection counts as enabled (and is omitted
 *   from `disabledGroups`); otherwise it counts as disabled and lands
 *   under the first disabled verdict's reason. This flatten is lossy
 *   on a multi-connection runtime — see the handler module-doc for
 *   the consequences and the v2 (multi-connection) shape on
 *   {@linkcode ToolGatingReport}.
 * - Throws `Wacky -- ...` if any handler returns an empty verdict map
 *   (a runtime-shaped invariant violation rather than a tool-state
 *   condition; see `classifyTool` for the rationale).
 */
export function buildToolGatingReport(
  handlers: Iterable<readonly [ToolName, ToolHandler]>,
  runtime: ServerRuntime,
): ToolGatingReport {
  // Map<reason, ToolName[]>; insertion order doesn't matter — the projection
  // step below sorts groups lex by reason.
  const groupsByReason = new Map<ToolDisabledReason, ToolName[]>();
  let enabledCount = 0;
  let disabledCount = 0;

  for (const [toolName, handler] of handlers) {
    const classification = classifyTool(handler.connectionVerdicts(runtime));
    if (classification.kind === "enabled") {
      enabledCount += 1;
      continue;
    }
    disabledCount += 1;
    let bucket = groupsByReason.get(classification.reason);
    bucket ??= [];
    groupsByReason.set(classification.reason, bucket);
    bucket.push(toolName);
  }

  const disabledGroups: DisabledToolsByReason[] = Array.from(
    groupsByReason.entries(),
  )
    .map(([reason, tools]) => ({ reason, tools }))
    .sort((a, b) => a.reason.localeCompare(b.reason));

  return { disabledGroups, enabledCount, disabledCount };
}

/**
 * Reduce a tool's per-connection verdict map to a single classification for
 * the v1 flat report. Under the single-connection invariant the verdict map
 * has exactly one entry, so this is a pass-through; the implementation
 * tolerates multi-entry maps (test fixtures synthesise them) by treating
 * "enabled on at least one connection" as enabled and otherwise reporting
 * the first disabled verdict's reason.
 *
 * v2 multi-connection: drop this helper. The aggregation moves into the
 * caller, which builds per-connection rows and cross-connection deltas
 * directly from the verdict map.
 */
function classifyTool(
  verdicts: Map<string, PredicateResult>,
): { kind: "enabled" } | { kind: "disabled"; reason: ToolDisabledReason } {
  let firstDisabledReason: ToolDisabledReason | undefined;
  for (const verdict of verdicts.values()) {
    if (verdict.enabled) return { kind: "enabled" };
    if (firstDisabledReason === undefined) {
      firstDisabledReason = verdict.reason;
    }
  }
  if (firstDisabledReason === undefined) {
    // Wacky -- handler returned an empty verdict map. BaseToolHandler builds
    // verdicts directly from `runtime.config.connections`, so an empty map
    // means there are zero configured connections, which
    // `enforceSingleConnectionOnly()` in `src/config/models.ts` should have
    // prevented at bootstrap. Fail loudly rather than fabricate a
    // misleading `ToolDisabledReason` and ship it in the operator-facing
    // report — a wrong-by-name reason is harder to diagnose than a stack
    // trace.
    throw new Error(
      "Wacky -- classifyTool received an empty verdict map: a handler's " +
        "connectionVerdicts() returned no entries. BaseToolHandler derives " +
        "verdicts from runtime.config.connections; an empty map implies zero " +
        "configured connections, which enforceSingleConnectionOnly() in " +
        "src/config/models.ts should have rejected at bootstrap.",
    );
  }
  return { kind: "disabled", reason: firstDisabledReason };
}
