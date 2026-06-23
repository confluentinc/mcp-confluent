import { CallToolResult } from "@src/confluent/schema.js";
import {
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  alwaysEnabled,
  ToolDisabledReason,
} from "@src/confluent/tools/connection-predicates.js";
import {
  buildToolGatingReport,
  type ConnectionGatingSection,
  type DisabledToolGroup,
  disabledToolGroupKey,
  type ToolGatingReport,
} from "@src/confluent/tools/tool-availability.js";
import { ToolMetadataHandler } from "@src/confluent/tools/tool-metadata-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const explainDisabledToolsArguments = z.object({
  group_by: z
    .enum(["reason", "category"])
    .default("reason")
    .describe(
      'Axis to bucket each connection\'s disabled tools by. "reason" (default) answers "what config piece would unlock these?" — each bucket is a ToolDisabledReason (MissingKafkaBlock, MissingFlinkBlock, …). "category" answers "which functional area is offline?" — each bucket is a ToolCategory (kafka, flink, schema-registry, …). Flip to "category" when triaging a misconfigured connection by functional area instead of by missing config piece.',
    ),
});

/**
 * Diagnostic tool that surfaces *why* tools are absent from `tools/list` or
 * unavailable on a given connection.
 *
 * `tools/list` advertises the enabled tool set but not the predicate-driven
 * decision behind every absence. This handler returns that view, shaped around
 * connections: one section per configured connection listing the tools
 * disabled on it (bucketed by the missing config piece, or by functional area
 * under `group_by="category"`). A tool enabled on one connection and disabled
 * on another shows up in the latter's section, so the cross-connection
 * asymmetry is readable by comparing sections. A zero-connection config
 * collapses to a dedicated summary; a single-connection config is simply one
 * section. Connection-independent tools are advertised everywhere and never
 * appear in a section.
 *
 * The structured `_meta` mirrors the rendered text; see the
 * {@linkcode ToolGatingReport} JSDoc in `tool-availability.ts`.
 *
 * Always enabled (predicate is `alwaysEnabled`) so an operator can call it
 * to diagnose a config that left every other tool disabled.
 *
 * The tool catalog is supplied through the thunk that {@link
 * ToolMetadataHandler} owns, for the ESM-cycle reason documented there.
 */
export class ExplainDisabledToolsHandler extends ToolMetadataHandler {
  handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): CallToolResult {
    const { group_by } = explainDisabledToolsArguments.parse(
      toolArguments ?? {},
    );
    const report = buildToolGatingReport(
      this.getToolNamesAndHandlers(),
      runtime,
      group_by,
    );
    return this.createResponse(renderReport(report), false, { ...report });
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.EXPLAIN_DISABLED_TOOLS,
      description:
        'Call when the user asks why a tool is missing or unavailable (e.g., "why can\'t I list Kafka topics?", "where are the Flink tools?"). Returns disabled tools organized per connection — each connection\'s gaps bucketed by the config piece each tool is waiting on, so you can tell the user the exact YAML block or field to add (and, with more than one connection, which connection needs it). Pass group_by="category" to bucket each connection\'s gaps by functional area (kafka, flink, schema-registry, …) instead of by missing config piece. Prefer this over guessing about credentials, network, or auth.',
      inputSchema: explainDisabledToolsArguments.shape,
      annotations: READ_ONLY,
    };
  }

  readonly category = ToolCategory.McpServerDiagnostics;
  readonly predicate = alwaysEnabled;
}

/**
 * Render a {@linkcode ToolGatingReport} as the human-readable text body of
 * the tool's response. Format is stable — handler tests pin specific
 * substrings so the AI/script-facing structure does not drift silently.
 *
 * Two orthogonal parts, each present only when it has something to say, joined
 * by a blank line:
 *   - the server-wide operator allow/block-list block, when any tool was
 *     excluded by it (rendered first, since the operator filter is the
 *     outermost gate);
 *   - the connection-shaped part: a no-connections summary, or a
 *     `Per-connection tool gating (by {axis}):` heading with one section per
 *     gapped connection and a closing advertised-count line.
 *
 * When neither part has anything to report, a one-line "all advertised"
 * summary stands in.
 *
 * Operator block (top-level header, two-space bullets):
 *
 *   excluded by the operator's allow/block-list (2):
 *     - list-topics
 *     - create-topics
 *
 * Section layout (two-space connection header, four-space bucket header,
 * six-space bullets):
 *
 *   Per-connection tool gating (by reason):
 *
 *     Connection 'local-kafka' — 3 of 40 tools disabled:
 *       {reason or category} ({n}):
 *         - {tool}
 *         …
 *
 *   {enabled} tools advertised via tools/list.
 */
function renderReport(report: ToolGatingReport): string {
  const total = report.enabledCount + report.disabledCount;

  const operatorBlock =
    report.operatorBlocked.length > 0
      ? renderOperatorBlock(report.operatorBlocked)
      : undefined;
  const connectionPart = renderConnectionPart(report, total);

  if (operatorBlock === undefined && connectionPart === undefined) {
    return `All ${total} registered tools are advertised via tools/list.`;
  }

  // Blank line between the two parts so they stay visually separate.
  return [operatorBlock, connectionPart]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

/**
 * The connection-shaped portion of the report, or `undefined` when there is
 * nothing connection-side to say (a zero-connection config whose only disabled
 * tools are operator-blocked, or a populated config with every
 * connection-dependent tool advertised). The operator-blocked tally is
 * excluded from the no-connections "connection-gated" count — those tools are
 * already accounted for in the operator block.
 */
function renderConnectionPart(
  report: ToolGatingReport,
  total: number,
): string | undefined {
  if (report.connections.length === 0) {
    const connectionGated =
      report.disabledCount - report.operatorBlocked.length;
    if (connectionGated === 0) return undefined;
    return `No connections are configured — ${connectionGated} of ${total} tools are connection-gated and unavailable; ${report.enabledCount} connection-independent tools remain available.`;
  }

  const gappedSections = report.connections.filter(
    (section) => section.disabledCount > 0,
  );
  if (gappedSections.length === 0) return undefined;

  return [
    `Per-connection tool gating (by ${report.groupBy}):`,
    ...gappedSections.map((section) => renderConnectionSection(section, total)),
    `${report.enabledCount} tools advertised via tools/list.`,
  ].join("\n\n");
}

/**
 * Render the server-wide operator allow/block-list block: a header naming the
 * reason and count, then one two-space bullet per excluded tool in handler
 * iteration order.
 */
function renderOperatorBlock(blocked: readonly ToolName[]): string {
  const header = `${ToolDisabledReason.OperatorBlocked} (${blocked.length}):`;
  const bullets = blocked.map((tool) => `  - ${tool}`);
  return [header, ...bullets].join("\n");
}

function renderConnectionSection(
  section: ConnectionGatingSection,
  total: number,
): string {
  const header = `  Connection '${section.connectionId}' — ${section.disabledCount} of ${total} tools disabled:`;
  return [header, ...section.disabledGroups.map(renderGroup)].join("\n");
}

function renderGroup(group: DisabledToolGroup): string {
  const header = `    ${disabledToolGroupKey(group)} (${group.tools.length}):`;
  const bullets = group.tools.map((tool) => `      - ${tool}`);
  return [header, ...bullets].join("\n");
}
