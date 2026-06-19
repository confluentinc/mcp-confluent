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
import { buildConnectionCard } from "@src/confluent/tools/handlers/diagnostics/describe-fields.js";
import { ToolMetadataHandler } from "@src/confluent/tools/tool-metadata-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { quoteJoinIds } from "@src/utils/quote-join-ids.js";
import { z } from "zod";

const describeConfiguredConnectionArguments = z.object({
  connectionId: z
    .string()
    .min(1, "connectionId cannot be empty")
    .describe(
      "The id of the configured connection to describe. One of the keys reported by 'list-configured-connections'.",
    ),
});

/**
 * The single-connection card a {@link DescribeConfiguredConnectionHandler}
 * returns: the connection's non-secret scalars and config blocks, its resolved
 * read-only posture, and the connection-routable tools split into the enabled
 * set and the disabled-by-reason map. `connectionId` plus the connection's
 * public scalars (`type`, optional `description`, and OAuth's `ccloud_env` /
 * `kafka_debug`) are flattened onto the top level via {@link buildConnectionCard}.
 */
interface ConnectionDescription {
  connectionId: string;
  readOnly: boolean;
  blocks: Record<string, Record<string, unknown>>;
  enabledTools: ToolName[];
  disabledTools: Record<string, ToolName[]>;
  [scalar: string]: unknown;
}

/**
 * Discovery tool: the per-connection counterpart to `list-configured-connections`.
 * Given one `connectionId`, returns its non-secret config card plus which
 * connection-routable tools are enabled on it and, for those that aren't, the
 * reason each is gated off.
 *
 * The enabled/disabled split is read from each handler's
 * {@link import("@src/confluent/tools/base-tools.js").ToolHandler.connectionVerdicts}
 * indexed at the requested connection — the same source `explain-disabled-tools`
 * consumes. The read-only overlay therefore needs no special-casing here: a
 * mutating tool on a `read_only` connection surfaces in the
 * {@link ToolDisabledReason.ReadOnlyConnection} bucket automatically, kept
 * distinct from the service-block-missing buckets, and the text summary renders
 * that bucket affirmatively as the set of writes the flag suppresses.
 *
 * Always enabled (predicate is `alwaysEnabled`) so an operator can introspect a
 * connection even when its config left every routable tool disabled. The
 * connection-routability filter and the catalog thunk both come from
 * {@link ToolMetadataHandler}.
 */
export class DescribeConfiguredConnectionHandler extends ToolMetadataHandler {
  handle(
    runtime: ServerRuntime,
    toolArguments?: Record<string, unknown>,
  ): CallToolResult {
    const { connectionId } = describeConfiguredConnectionArguments.parse(
      toolArguments ?? {},
    );

    const conn = runtime.config.connections[connectionId];
    if (conn === undefined) {
      return this.createResponse(
        `Unknown connection id "${connectionId}". Configured connections: ${
          quoteJoinIds(runtime.config.getConnectionIds()) || "none"
        }.`,
        true,
      );
    }

    const { scalars, blocks } = buildConnectionCard(conn);

    const enabledTools: ToolName[] = [];
    const disabledTools: Record<string, ToolName[]> = {};
    for (const [name, handler] of this.connectionRoutableTools(runtime)) {
      // Every configured connection has a verdict (connectionVerdicts iterates
      // runtime.config.connections), so the lookup is always defined.
      const verdict = handler.connectionVerdicts(runtime).get(connectionId)!;
      if (verdict.enabled) {
        enabledTools.push(name);
      } else {
        const bucket = disabledTools[verdict.reason] ?? [];
        disabledTools[verdict.reason] = bucket;
        bucket.push(name);
      }
    }
    enabledTools.sort((a, b) => a.localeCompare(b));
    for (const tools of Object.values(disabledTools)) {
      tools.sort((a, b) => a.localeCompare(b));
    }

    const description: ConnectionDescription = {
      connectionId,
      ...scalars,
      readOnly: conn.read_only === true,
      blocks,
      enabledTools,
      disabledTools,
    };

    return this.createStructuredResponse(
      renderCard(description, conn.type),
      description,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DESCRIBE_CONFIGURED_CONNECTION,
      description:
        "Describe one configured connection by id: its non-secret config (type, endpoints, resource ids — never credentials), whether it is read-only, the tools you can invoke against it, and, for tools that are unavailable on it, the config gap or policy keeping each one off. Pass the connection id from 'list-configured-connections'. Call this to learn what a specific connection supports before routing a tool call to it.",
      inputSchema: describeConfiguredConnectionArguments.shape,
      annotations: READ_ONLY,
    };
  }

  readonly category = ToolCategory.McpServerDiagnostics;
  readonly predicate = alwaysEnabled;
}

/**
 * Human-readable summary of the connection card. The structured payload is
 * authoritative; this text is the at-a-glance view. The read-only suppressed
 * line reads the {@link ToolDisabledReason.ReadOnlyConnection} bucket directly,
 * so it surfaces with no enum-specific branching beyond that one key.
 */
function renderCard(card: ConnectionDescription, type: string): string {
  const lines: string[] = [];
  const readOnlyMarker = card.readOnly ? ", read-only" : "";
  lines.push(`Connection "${card.connectionId}" (${type}${readOnlyMarker})`);

  const description = card.description;
  if (typeof description === "string") {
    lines.push(`Description: ${description}`);
  }

  const blockNames = Object.keys(card.blocks).sort((a, b) =>
    a.localeCompare(b),
  );
  if (blockNames.length > 0) {
    lines.push(`Configured blocks: ${blockNames.join(", ")}`);
  }

  const enabledCount = card.enabledTools.length;
  lines.push(
    `${enabledCount} tool${enabledCount === 1 ? "" : "s"} enabled${
      enabledCount > 0 ? `: ${card.enabledTools.join(", ")}` : ""
    }`,
  );

  const suppressed = card.disabledTools[ToolDisabledReason.ReadOnlyConnection];
  if (card.readOnly && suppressed !== undefined && suppressed.length > 0) {
    lines.push(
      `${suppressed.length} mutating tool${
        suppressed.length === 1 ? "" : "s"
      } suppressed by read_only: ${suppressed.join(", ")}`,
    );
  }

  const disabledEntries = Object.entries(card.disabledTools).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  if (disabledEntries.length > 0) {
    const disabledCount = disabledEntries.reduce(
      (sum, [, tools]) => sum + tools.length,
      0,
    );
    lines.push(
      `${disabledCount} tool${disabledCount === 1 ? "" : "s"} disabled:`,
    );
    for (const [reason, tools] of disabledEntries) {
      lines.push(`  ${reason} (${tools.length}): ${tools.join(", ")}`);
    }
  }

  return lines.join("\n");
}
