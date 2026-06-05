import { CallToolResult } from "@src/confluent/schema.js";
import {
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { alwaysEnabled } from "@src/confluent/tools/connection-predicates.js";
import { ToolMetadataHandler } from "@src/confluent/tools/tool-metadata-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const listConnectionsArguments = z.object({});

/**
 * Discovery tool: maps each configured connection id to the tools an agent can
 * actually invoke against it. "Actually invokable" means a tool both survived
 * the operator's allow/block-list and whose predicate enables that specific
 * connection — the same two gates tool registration applies, so this listing
 * can never claim a tool the server didn't advertise.
 *
 * This tool itself is always enabled (predicate = `alwaysEnabled`) but intentionally excludes
 * connection-agnostic tools from the per-connection lists: a tool whose predicate is `alwaysEnabled`
 * applies to every connection, so listing it under each connection would misrepresent it as
 * connection-routable. This tool answers "which connections are available and which tools
 * are directly useable on each."
 *
 * The tool catalog is supplied through the thunk that {@link
 * ToolMetadataHandler} owns, for the ESM-cycle reason documented there.
 */
export class ListConnectionsHandler extends ToolMetadataHandler {
  handle(
    runtime: ServerRuntime,
    toolArguments?: Record<string, unknown>,
  ): CallToolResult {
    listConnectionsArguments.parse(toolArguments ?? {});

    const handlers = this.getToolNamesAndHandlers();
    const connections: Record<string, { enabledTools: ToolName[] }> = {};
    for (const connId of Object.keys(runtime.config.connections)) {
      const enabledTools = handlers
        .filter(
          ([name, handler]) =>
            runtime.isToolAllowed(name) &&
            // Skip connection-agnostic tools (predicate === alwaysEnabled):
            // they take no connectionId and apply to every connection, so
            // listing them per connection would misrepresent them as
            // connection-routable. This map answers "which tools route to
            // this connection id?" — the always-on set is orthogonal.
            handler.predicate !== alwaysEnabled &&
            handler.enabledConnectionIds(runtime).includes(connId),
        )
        .map(([name]) => name)
        .sort();
      connections[connId] = { enabledTools };
    }

    return this.createStructuredResponse(renderSummary(connections), {
      connections,
    });
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_CONNECTIONS,
      description:
        "List every configured connection and the tools you can invoke against each. The connection id (the map key) is the value to pass as the `connectionId` argument on tools that ask for one. Call this when a tool offers a choice of connections, or to discover which connection supports the capability you need.",
      inputSchema: listConnectionsArguments.shape,
      annotations: READ_ONLY,
    };
  }

  readonly category = ToolCategory.McpServerDiagnostics;
  readonly predicate = alwaysEnabled;
}

/**
 * Human-readable summary of the connection→tools mapping. The structured
 * payload is authoritative; this text is the at-a-glance view. Handler tests
 * pin the empty-config sentence so the no-connections path stays stable.
 */
function renderSummary(
  connections: Record<string, { enabledTools: ToolName[] }>,
): string {
  const entries = Object.entries(connections);
  if (entries.length === 0) {
    return "No connections are configured.";
  }
  const lines = entries.map(([id, { enabledTools }]) => {
    const count = enabledTools.length;
    const list = count > 0 ? enabledTools.join(", ") : "(none)";
    return `  ${id} (${count} tool${count === 1 ? "" : "s"}): ${list}`;
  });
  return [
    `${entries.length} connection${entries.length === 1 ? "" : "s"} configured:`,
    "",
    ...lines,
  ].join("\n");
}
