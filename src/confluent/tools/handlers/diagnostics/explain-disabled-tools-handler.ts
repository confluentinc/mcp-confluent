import { CallToolResult } from "@src/confluent/schema.js";
import {
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { alwaysEnabled } from "@src/confluent/tools/connection-predicates.js";
import {
  buildToolGatingReport,
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
      'Axis to bucket disabled tools by. "reason" (default) answers "what config piece would unlock these?" — each bucket is a ToolDisabledReason (MissingKafkaBlock, MissingFlinkBlock, …). "category" answers "which functional area is offline?" — each bucket is a ToolCategory (kafka, flink, schema-registry, …). Flip to "category" when triaging a misconfigured connection by functional area instead of by missing config piece.',
    ),
});

/**
 * Diagnostic tool that surfaces *why* tools are absent from `tools/list`.
 *
 * The MCP protocol already advertises the enabled tool set via `tools/list`;
 * what it does not surface is the predicate-driven decision behind every
 * absence — which config piece is missing, and which tools each gap would
 * unlock. This handler returns that view.
 *
 * Current shape: a flat list of disabled tools grouped by the missing config
 * piece (kafka block, flink block, schema registry block, …), or by
 * `NoConnectionsConfigured` when the config has no connections at all. Tools
 * enabled on any connection are intentionally absent — `tools/list` already
 * advertises them.
 *
 * The flatten is *lossy* on a multi-connection config: a tool enabled on at
 * least one connection is reported as enabled (and omitted from
 * `disabledGroups` entirely), and a tool disabled on several connections with
 * different reasons is bucketed under the first disabled verdict its iteration
 * produces — the cross-connection asymmetry vanishes from the output.
 *
 * #559 regrows the output around connections: one block per connection
 * (header + per-connection gaps) plus a `Cross-connection deltas` section
 * surfacing tools enabled on some connections but not others — the canonical
 * "what does connection B need to reach parity with connection A?" view. The
 * structured `_meta` shape mirrors that change; see the
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
        'Call when the user asks why a tool is missing or unavailable (e.g., "why can\'t I list Kafka topics?", "where are the Flink tools?"). Returns disabled tools grouped by the config gap each one is waiting on, so you can tell the user the exact YAML block or field to add. Pass group_by="category" to regroup by functional area (kafka, flink, schema-registry, …) when the user\'s question is framed by what\'s offline rather than by what\'s missing from config. Prefer this over guessing about credentials, network, or auth.',
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
 * The heading line varies by `report.groupBy`:
 *
 *   - `"reason"`: "{disabled} of {total} tools disabled for the following reasons:"
 *   - `"category"`: "{disabled} of {total} tools disabled across the following categories:"
 *
 * Body shape is identical for both axes — one header line per bucket
 * followed by indented `- {tool}` bullets, separated by a blank line:
 *
 *   {disabled} of {total} tools disabled for the following reasons:
 *
 *     {reason or category} ({n}):
 *       - {tool}
 *       - {tool}
 *       …
 *
 *     {next bucket} ({n}):
 *       - {tool}
 *       …
 *
 *   {enabled} tools advertised via tools/list.
 *
 * Two-space indent on the bucket header, four-space indent on the bullets.
 *
 * v2 (#559, multi-connection): grow a per-connection section (header +
 * per-connection gaps) plus an optional `Cross-connection deltas` section.
 * See the handler's class JSDoc for the migration sketch.
 */
function renderReport(report: ToolGatingReport): string {
  const total = report.enabledCount + report.disabledCount;
  if (report.disabledCount === 0) {
    return `All ${total} registered tools are advertised via tools/list.`;
  }

  const headingTail =
    report.groupBy === "reason"
      ? "for the following reasons"
      : "across the following categories";

  // Each group's render contains its own header line + indented bullets;
  // joining with a blank line separates groups visually so long bullet
  // lists from one group don't bleed into the next.
  return [
    `${report.disabledCount} of ${total} tools disabled ${headingTail}:`,
    "",
    report.disabledGroups.map(renderGroup).join("\n\n"),
    "",
    `${report.enabledCount} tools advertised via tools/list.`,
  ].join("\n");
}

function renderGroup(group: DisabledToolGroup): string {
  const header = `  ${disabledToolGroupKey(group)} (${group.tools.length}):`;
  const bullets = group.tools.map((tool) => `    - ${tool}`);
  return [header, ...bullets].join("\n");
}
