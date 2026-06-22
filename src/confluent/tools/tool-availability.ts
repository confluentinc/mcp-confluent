import { ToolCategory, ToolHandler } from "@src/confluent/tools/base-tools.js";
import { ToolDisabledReason } from "@src/confluent/tools/connection-predicates.js";
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
 * One configured connection's view of the gating report: the tools disabled
 * *on this connection*, bucketed by the report's chosen axis, plus the
 * connection's own enabled/disabled tallies. A tool enabled on this connection
 * never appears in `disabledGroups` here; a tool enabled on a sibling
 * connection but disabled on this one shows up in this section's buckets, so
 * the cross-connection asymmetry is readable by comparing sections.
 */
export interface ConnectionGatingSection {
  readonly connectionId: string;
  readonly disabledGroups: readonly DisabledToolGroup[];
  /** Tools advertisable on this connection: `totalRegistered - disabledCount`. */
  readonly enabledCount: number;
  /** Tools disabled on this connection: the sum of `disabledGroups[].tools.length`. */
  readonly disabledCount: number;
}

/**
 * Output of {@linkcode buildToolGatingReport}; drives the
 * `explain-disabled-tools` diagnostic tool.
 *
 * The report is connection-shaped: one {@linkcode ConnectionGatingSection} per
 * configured connection, each carrying that connection's disabled-tool buckets.
 * A single-connection config yields exactly one section — there is one shape
 * regardless of connection count.
 *
 * `groupBy` records which axis the section buckets carry so consumers
 * (renderer, MCP-client UIs) can pick the right framing.
 *
 * The top-level `enabledCount` / `disabledCount` are whole-server rollups: a
 * tool counts as enabled if it is connection-independent or enabled on at
 * least one connection, and disabled only when it is connection-dependent and
 * dark on every connection (or there are no connections at all).
 */
export interface ToolGatingReport {
  readonly groupBy: "reason" | "category";
  /** One section per configured connection, lex-sorted by id; empty iff no connections are configured. */
  readonly connections: readonly ConnectionGatingSection[];
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
 * Assemble a connection-shaped {@linkcode ToolGatingReport} for the given
 * handler set against the configured connections.
 *
 * One pass over the handlers:
 * - connection-independent tools count as enabled and appear in no section
 *   (they are enabled on every connection);
 * - a connection-dependent tool on a zero-connection config counts as disabled
 *   with no section to attribute it to;
 * - otherwise each connection that disables it gets the tool added to its
 *   section bucket (keyed by reason, or by {@linkcode ToolHandler.category}
 *   under `groupBy: "category"`), and the tool counts as enabled iff at least
 *   one connection enables it.
 *
 * Sections are lex-sorted by `connectionId` and buckets lex by
 * {@linkcode disabledToolGroupKey}. Tools within a bucket follow handler
 * iteration order.
 */
export function buildToolGatingReport(
  handlers: Iterable<readonly [ToolName, ToolHandler]>,
  runtime: ServerRuntime,
  groupBy: "reason" | "category" = "reason",
): ToolGatingReport {
  const connectionIds = runtime.config.getConnectionIds();
  // Per-connection accumulator: connectionId -> (bucketKey -> tools). Both
  // axes' keys (ToolDisabledReason / ToolCategory values) are string enums at
  // runtime, so a single string-keyed inner Map drives both code paths.
  const sectionBuckets: SectionBuckets = new Map(
    connectionIds.map((id) => [id, new Map<string, ToolName[]>()]),
  );
  let enabledCount = 0;
  let disabledCount = 0;

  for (const [toolName, handler] of handlers) {
    if (
      classifyAndBucketHandler(
        toolName,
        handler,
        runtime,
        groupBy,
        sectionBuckets,
      )
    ) {
      enabledCount += 1;
    } else {
      disabledCount += 1;
    }
  }

  const totalRegistered = enabledCount + disabledCount;
  const connections = connectionIds
    .map((id) =>
      buildSection(id, sectionBuckets.get(id)!, groupBy, totalRegistered),
    )
    .sort((a, b) => a.connectionId.localeCompare(b.connectionId));

  return {
    groupBy,
    connections,
    enabledCount,
    disabledCount,
  };
}

/**
 * Per-connection bucket accumulator: connectionId → (bucketKey → tools), where
 * the bucket key is a {@linkcode ToolDisabledReason} or {@linkcode ToolCategory}
 * string value depending on the report's axis.
 */
type SectionBuckets = Map<string, Map<string, ToolName[]>>;

/**
 * Classify one handler for the report and, as a side effect, bucket its tool
 * into the section of every connection that disables it. Returns `true` when
 * the tool is advertised (connection-independent, or enabled on at least one
 * connection) — i.e. when it counts toward `enabledCount` rather than
 * `disabledCount`. A connection-dependent tool on a zero-connection config is
 * dark with no section to attribute it to.
 */
function classifyAndBucketHandler(
  toolName: ToolName,
  handler: ToolHandler,
  runtime: ServerRuntime,
  groupBy: "reason" | "category",
  sectionBuckets: SectionBuckets,
): boolean {
  if (handler.isConnectionIndependent) return true;
  const verdicts = handler.connectionVerdicts(runtime);
  if (verdicts.size === 0) return false;

  let anyEnabled = false;
  for (const [connectionId, verdict] of verdicts) {
    if (verdict.enabled) {
      anyEnabled = true;
      continue;
    }
    const key = groupBy === "reason" ? verdict.reason : handler.category;
    pushToBucket(sectionBuckets.get(connectionId)!, key, toolName);
  }
  return anyEnabled;
}

/** Append `toolName` to `buckets[key]`, creating the bucket array on first use. */
function pushToBucket(
  buckets: Map<string, ToolName[]>,
  key: string,
  toolName: ToolName,
): void {
  let bucket = buckets.get(key);
  bucket ??= [];
  buckets.set(key, bucket);
  bucket.push(toolName);
}

/**
 * Assemble one connection's {@linkcode ConnectionGatingSection} from its bucket
 * accumulator. `enabledCount` is the complement of this connection's disabled
 * tally against the whole registered set, so connection-independent tools count
 * as enabled here.
 */
function buildSection(
  connectionId: string,
  buckets: Map<string, ToolName[]>,
  groupBy: "reason" | "category",
  totalRegistered: number,
): ConnectionGatingSection {
  const disabledGroups = bucketsToGroups(buckets, groupBy);
  const sectionDisabled = disabledGroups.reduce(
    (sum, group) => sum + group.tools.length,
    0,
  );
  return {
    connectionId,
    disabledGroups,
    enabledCount: totalRegistered - sectionDisabled,
    disabledCount: sectionDisabled,
  };
}

/**
 * Project one connection's `(bucketKey -> tools)` accumulator into the
 * discriminated {@linkcode DisabledToolGroup} array, lex-sorted by bucket key.
 */
function bucketsToGroups(
  buckets: Map<string, ToolName[]>,
  groupBy: "reason" | "category",
): DisabledToolGroup[] {
  return Array.from(buckets.entries())
    .map(
      ([key, tools]): DisabledToolGroup =>
        groupBy === "reason"
          ? { reason: key as ToolDisabledReason, tools }
          : { category: key as ToolCategory, tools },
    )
    .sort((a, b) =>
      disabledToolGroupKey(a).localeCompare(disabledToolGroupKey(b)),
    );
}
