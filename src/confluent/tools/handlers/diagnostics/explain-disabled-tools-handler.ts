import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
  ToolDomain,
  ToolHandler,
} from "@src/confluent/tools/base-tools.js";
import { alwaysEnabled } from "@src/confluent/tools/connection-predicates.js";
import {
  buildToolGatingReport,
  type DisabledToolsByReason,
  type ToolGatingReport,
} from "@src/confluent/tools/tool-availability.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const explainDisabledToolsArguments = z.object({});

/**
 * Diagnostic tool that surfaces *why* tools are absent from `tools/list`.
 *
 * The MCP protocol already advertises the enabled tool set via `tools/list`;
 * what it does not surface is the predicate-driven decision behind every
 * absence — which config piece is missing, and which tools each gap would
 * unlock. This handler returns that view.
 *
 * v1 scope (today's release): the server enforces a single configured
 * connection (see `enforceSingleConnectionOnly()` in
 * `src/config/models.ts`), so the output is a flat list of disabled tools
 * grouped by the missing config piece (kafka block, flink block, schema
 * registry block, …). Tools enabled on the active connection are
 * intentionally absent — `tools/list` already advertises them.
 *
 * v2 plan (when multi-connection support lands — issue #151's follow-ups):
 * regrow output around connections. The text body becomes one block per
 * connection (header + per-connection gaps) plus a `Cross-connection
 * deltas` section that surfaces tools enabled on some connections but not
 * others — the canonical "what does connection B need to reach parity with
 * connection A?" view. The structured `_meta` shape mirrors that change;
 * see the {@linkcode ToolGatingReport} JSDoc in `tool-availability.ts` for
 * the exact target type.
 *
 * Until v2 lands, the helper accepts a multi-connection runtime without
 * crashing, but the v1 flatten is *lossy*: a tool whose predicate is
 * enabled on at least one configured connection is reported as enabled
 * (and therefore omitted from `disabledGroups` entirely), and a tool
 * disabled on multiple connections with different reasons is bucketed
 * under the first disabled verdict its iteration produces — the
 * cross-connection asymmetry vanishes from the output. Today's
 * single-connection invariant means neither lossy case can fire in
 * production; this paragraph exists so a future reader does not mistake
 * defensive iteration for parity reporting.
 *
 * Always enabled (predicate is `alwaysEnabled`) so an operator can call it
 * to diagnose a config that left every other tool disabled.
 *
 * The handlers iterable is supplied at construction time via a thunk so
 * this module does not need to import `ToolHandlerRegistry`. Importing the
 * registry from a registered handler would create an ESM cycle, leaving
 * the registry's static initializer running before this class's binding
 * is set. The thunk is invoked at request time, after every module is
 * fully loaded, sidestepping the cycle entirely.
 */
export class ExplainDisabledToolsHandler extends BaseToolHandler {
  private readonly listHandlers: () => Iterable<
    readonly [ToolName, ToolHandler]
  >;

  constructor(listHandlers: () => Iterable<readonly [ToolName, ToolHandler]>) {
    super();
    this.listHandlers = listHandlers;
  }

  handle(runtime: ServerRuntime): CallToolResult {
    const report = buildToolGatingReport(this.listHandlers(), runtime);
    return this.createResponse(renderReport(report), false, { ...report });
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.EXPLAIN_DISABLED_TOOLS,
      description:
        'Call when the user asks why a tool is missing or unavailable (e.g., "why can\'t I list Kafka topics?", "where are the Flink tools?"). Returns disabled tools grouped by the config gap each one is waiting on, so you can tell the user the exact YAML block or field to add. Prefer this over guessing about credentials, network, or auth.',
      inputSchema: explainDisabledToolsArguments.shape,
      annotations: READ_ONLY,
    };
  }

  readonly domain = ToolDomain.McpServerDiagnostics;
  readonly predicate = alwaysEnabled;
}

/**
 * Render a {@linkcode ToolGatingReport} as the human-readable text body of
 * the tool's response. Format is stable — handler tests pin specific
 * substrings so the AI/script-facing structure does not drift silently.
 *
 * v1 (single-connection) shape:
 *
 *   {disabled} of {total} tools disabled for the following reasons:
 *
 *     {reason} ({n}):
 *       - {tool}
 *       - {tool}
 *       …
 *
 *     {next reason} ({n}):
 *       - {tool}
 *       …
 *
 *   {enabled} tools advertised via tools/list.
 *
 * Each disabled-reason group is a header line followed by one tool per
 * indented bullet (two-space indent on the reason header, four-space
 * indent on the bullets). Groups are separated by a blank line so
 * adjacent buckets stay visually distinct.
 *
 * v2 (multi-connection): grow a connection header per per-connection
 * section and an optional `Cross-connection deltas` section. See the
 * handler's class JSDoc for the migration sketch.
 */
function renderReport(report: ToolGatingReport): string {
  const total = report.enabledCount + report.disabledCount;
  if (report.disabledCount === 0) {
    return `All ${total} registered tools are advertised via tools/list.`;
  }

  // Each group's render contains its own header line + indented bullets;
  // joining with a blank line separates groups visually so long bullet
  // lists from one group don't bleed into the next.
  return [
    `${report.disabledCount} of ${total} tools disabled for the following reasons:`,
    "",
    report.disabledGroups.map(renderGroup).join("\n\n"),
    "",
    `${report.enabledCount} tools advertised via tools/list.`,
  ].join("\n");
}

function renderGroup(group: DisabledToolsByReason): string {
  const header = `  ${group.reason} (${group.tools.length}):`;
  const bullets = group.tools.map((tool) => `    - ${tool}`);
  return [header, ...bullets].join("\n");
}
