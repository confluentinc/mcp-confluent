import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { ToolDisabledReason } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";

/**
 * One bucket of tools that all share the same `(connectionId, reason)` pair —
 * the unit of one log line at startup and one row in the `describe-tool-
 * availability` diagnostic surface. `toolNames` preserves the order tools
 * appeared in the input iterable.
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
