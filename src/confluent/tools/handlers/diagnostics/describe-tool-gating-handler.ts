import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
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

const describeToolGatingArguments = z.object({});

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
 * the exact target type. Until then this handler keeps a flat, single-
 * connection view, but the helper already iterates `runtime.config.connections`
 * defensively so multi-connection runtimes degrade gracefully (every
 * connection's verdict feeds into the same flat groups) rather than
 * crashing.
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
export class DescribeToolGatingHandler extends BaseToolHandler {
  private readonly listHandlers: () => Iterable<
    readonly [ToolName, ToolHandler]
  >;

  constructor(listHandlers: () => Iterable<readonly [ToolName, ToolHandler]>) {
    super();
    this.listHandlers = listHandlers;
  }

  handle(runtime: ServerRuntime): CallToolResult {
    const report = buildToolGatingReport(this.listHandlers(), runtime);
    return this.createResponse(
      renderReport(report),
      false,
      report as unknown as Record<string, unknown>,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DESCRIBE_TOOL_GATING,
      description:
        'When you can\'t find a tool to answer a user\'s request — e.g., the user asks "why can\'t I list Kafka topics?", "where are the Flink tools?", "I don\'t see anything for schema registry" — call this tool first. Returns the disabled tools grouped by what each tool\'s predicate found missing in the connection config (a kafka/flink/schema_registry/tableflow/telemetry block, a required field within one, or an OAuth-vs-direct-only mismatch). Tell the user the exact YAML to add or change. Always call this rather than speculating about credentials, network, or auth — the server already knows the verdict for every tool.',
      inputSchema: describeToolGatingArguments.shape,
      annotations: READ_ONLY,
    };
  }

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
 *     {reason} ({n}): {tool, tool, ...}
 *     ...
 *
 *   {enabled} tools advertised via tools/list.
 *
 * v2 (multi-connection): grow a connection header per per-connection
 * section and an optional `Cross-connection deltas` section. See the
 * handler's class JSDoc for the migration sketch.
 */
function renderReport(report: ToolGatingReport): string {
  const total = report.enabled_count + report.disabled_count;
  if (report.disabled_count === 0) {
    return `All ${total} registered tools are advertised via tools/list.`;
  }

  // Each group's render contains its own header line + indented bullets;
  // joining with a blank line separates groups visually so long bullet
  // lists from one group don't bleed into the next.
  return [
    `${report.disabled_count} of ${total} tools disabled for the following reasons:`,
    "",
    report.disabled_groups.map(renderGroup).join("\n\n"),
    "",
    `${report.enabled_count} tools advertised via tools/list.`,
  ].join("\n");
}

function renderGroup(group: DisabledToolsByReason): string {
  const header = `  ${group.reason} (${group.tools.length}):`;
  const bullets = group.tools.map((tool) => `    - ${tool}`);
  return [header, ...bullets].join("\n");
}
