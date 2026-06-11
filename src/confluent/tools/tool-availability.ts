import { ToolCategory, ToolHandler } from "@src/confluent/tools/base-tools.js";
import {
  PredicateResult,
  ToolDisabledReason,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";

/**
 * One bucket of disabled tools sharing a single bucket key. The key field
 * is discriminated by {@linkcode ToolGatingReport.groupBy}:
 *
 * - `groupBy: "reason"` ⇒ each bucket carries `reason: ToolDisabledReason`
 *   (the default — "what config piece would unlock these tools?").
 * - `groupBy: "category"` ⇒ each bucket carries `category: ToolCategory`
 *   ("which area of functionality is offline?").
 *
 * Use `"reason" in group` (or `"category" in group`) to narrow at the use site.
 * Tool order within `tools` follows the order handlers were iterated.
 */
export type DisabledToolGroup =
  | { readonly reason: ToolDisabledReason; readonly tools: readonly ToolName[] }
  | { readonly category: ToolCategory; readonly tools: readonly ToolName[] };

/** Bucket-key projection for a {@linkcode DisabledToolGroup}, irrespective of axis. */
export function disabledToolGroupKey(group: DisabledToolGroup): string {
  return "reason" in group ? group.reason : group.category;
}

/**
 * Output of {@linkcode buildToolGatingReport}; drives the
 * `explain-disabled-tools` diagnostic tool. Tools advertised via
 * `tools/list` are intentionally absent — the report carries the
 * negative signal only.
 *
 * `groupBy` records which axis the bucket discriminators carry so
 * consumers (renderer, MCP-client UIs) can pick the right framing.
 *
 * This is a flat report: each tool counts once as enabled or disabled across
 * the whole config, with no per-connection breakdown. On a multi-connection
 * config that flatten is lossy (a tool enabled on one connection and disabled
 * on another reads as simply enabled). #559 regrows the shape around
 * connections — per-connection sections plus a cross-connection-deltas section
 * calling out tools enabled on some connections but not others.
 */
export interface ToolGatingReport {
  readonly groupBy: "reason" | "category";
  readonly disabledGroups: readonly DisabledToolGroup[];
  readonly enabledCount: number;
  readonly disabledCount: number;
}

/**
 * One bucket of tools sharing the same `(connectionId, reason)` pair — the
 * unit of one grouped log line at server startup. `toolNames` preserves
 * input iteration order. Distinct from {@linkcode DisabledToolGroup}, which
 * is the operator-facing diagnostic-surface shape: this one carries the
 * `connectionId` axis the multi-connection log line needs.
 */
export interface StartupLogToolGroup {
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
): StartupLogToolGroup[] {
  const groups = new Map<string, StartupLogToolGroup>();
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
 * Assemble a {@linkcode ToolGatingReport} for the given handler set against the
 * configured connections.
 *
 * - `disabledGroups` is sorted lex by reason; tools within a group follow
 *   handler iteration order.
 * - Each tool contributes once to `enabledCount` *or* `disabledCount`, via
 *   {@linkcode classifyHandler}: connection-independent tools count as enabled;
 *   a connection-dependent tool enabled on at least one connection counts as
 *   enabled (and is omitted from `disabledGroups`); otherwise it counts as
 *   disabled and lands under either the first disabled verdict's reason or
 *   {@linkcode ToolDisabledReason.NoConnectionsConfigured} when the config has
 *   no connections at all. The single-connection-vs-multi flatten is lossy —
 *   see {@linkcode ToolGatingReport} and #559.
 */
export function buildToolGatingReport(
  handlers: Iterable<readonly [ToolName, ToolHandler]>,
  runtime: ServerRuntime,
  groupBy: "reason" | "category" = "reason",
): ToolGatingReport {
  // Both axes' keys (ToolDisabledReason values, ToolCategory values) are
  // string enums at runtime, so a single string-keyed Map drives both code
  // paths. The discriminator on the emitted DisabledToolGroup is what
  // tells the consumer which axis it's reading.
  const groups = new Map<string, ToolName[]>();
  let enabledCount = 0;
  let disabledCount = 0;

  for (const [toolName, handler] of handlers) {
    const classification = classifyHandler(handler, runtime);
    if (classification.kind === "enabled") {
      enabledCount += 1;
      continue;
    }
    disabledCount += 1;
    const key = groupBy === "reason" ? classification.reason : handler.category;
    let bucket = groups.get(key);
    bucket ??= [];
    groups.set(key, bucket);
    bucket.push(toolName);
  }

  const disabledGroups: DisabledToolGroup[] = Array.from(groups.entries())
    .map(
      ([key, tools]): DisabledToolGroup =>
        groupBy === "reason"
          ? { reason: key as ToolDisabledReason, tools }
          : { category: key as ToolCategory, tools },
    )
    .sort((a, b) =>
      disabledToolGroupKey(a).localeCompare(disabledToolGroupKey(b)),
    );

  return { groupBy, disabledGroups, enabledCount, disabledCount };
}

type ToolClassification =
  | { kind: "enabled" }
  | { kind: "disabled"; reason: ToolDisabledReason };

/**
 * Classify a single handler for the flat gating report. Three cases, in order:
 * a connection-independent tool is enabled regardless of how many connections
 * exist; a connection-dependent tool on a zero-connection config is disabled
 * under {@linkcode ToolDisabledReason.NoConnectionsConfigured} (there is no
 * per-connection verdict to attribute a reason to); otherwise the per-connection
 * verdicts decide via {@linkcode classifyVerdicts}.
 */
function classifyHandler(
  handler: ToolHandler,
  runtime: ServerRuntime,
): ToolClassification {
  if (handler.isConnectionIndependent) return { kind: "enabled" };
  const verdicts = handler.connectionVerdicts(runtime);
  if (verdicts.size === 0) {
    return {
      kind: "disabled",
      reason: ToolDisabledReason.NoConnectionsConfigured,
    };
  }
  return classifyVerdicts(verdicts);
}

/**
 * Reduce a non-empty per-connection verdict map to a single classification for
 * the flat report: "enabled on at least one connection" wins, otherwise the
 * first disabled verdict's reason. This flatten is lossy on a multi-connection
 * runtime — see {@linkcode ToolGatingReport} for the consequences and #559 for
 * the per-connection shape that replaces it.
 *
 * {@linkcode classifyHandler} handles the connection-independent and
 * zero-connection cases, so the map handed here is always non-empty and there
 * is always a verdict to read.
 */
function classifyVerdicts(
  verdicts: Map<string, PredicateResult>,
): ToolClassification {
  let firstDisabledReason: ToolDisabledReason | undefined;
  for (const verdict of verdicts.values()) {
    if (verdict.enabled) return { kind: "enabled" };
    firstDisabledReason ??= verdict.reason;
  }
  // Non-empty map with no enabled verdict, so a disabled reason was recorded.
  return { kind: "disabled", reason: firstDisabledReason! };
}
