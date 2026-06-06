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
 * Per-connection entry in the `list-connections` payload. `description` is the operator's
 * optional label from config, present only when the connection defined a non-blank one.
 */
interface ConnectionListing {
  description?: string;
  enabledTools: ToolName[];
}

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
 * are directly usable on each."
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

    const connections: Record<string, ConnectionListing> = {};
    for (const [connId, conn] of Object.entries(runtime.config.connections)) {
      // Omit the key entirely when there is no description (a blank one coerces
      // to undefined at config-parse time), so the listing never carries an
      // empty-string label.
      connections[connId] =
        conn.description !== undefined
          ? { description: conn.description, enabledTools: [] }
          : { enabledTools: [] };
    }

    // Single pass over the catalog: compute each tool's enabled connection ids
    // once and distribute it into those buckets. Asking
    // enabledConnectionIds() once per connection instead would be
    // O(tools × connections²), since it rescans every connection each call.
    for (const [name, handler] of this.getToolNamesAndHandlers()) {
      // Skip tools the operator filtered out, and connection-agnostic tools
      // (predicate === alwaysEnabled): they take no connectionId and apply to
      // every connection, so listing them per connection would misrepresent
      // them as connection-routable. This map answers "which tools route to
      // this connection id?" — the always-on set is orthogonal.
      if (!runtime.isToolAllowed(name) || handler.predicate === alwaysEnabled) {
        continue;
      }
      for (const connId of handler.enabledConnectionIds(runtime)) {
        connections[connId]?.enabledTools.push(name);
      }
    }

    for (const bucket of Object.values(connections)) {
      bucket.enabledTools.sort((a, b) => a.localeCompare(b));
    }

    return this.createStructuredResponse(renderSummary(connections), {
      connections,
    });
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_CONNECTIONS,
      description:
        "List every configured connection and the connection-routable tools you can invoke against each. The connection id (the map key) is the value to pass as the `connectionId` argument on tools that ask for one. Connection-agnostic tools (e.g. docs and diagnostics that take no `connectionId`) are always available and appear in `tools/list`, not here. Call this when a tool offers a choice of connections, or to discover which connection supports the capability you need.",
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
function renderSummary(connections: Record<string, ConnectionListing>): string {
  const entries = Object.entries(connections);
  if (entries.length === 0) {
    return "No connections are configured.";
  }
  const lines = entries.map(([id, { description, enabledTools }]) => {
    const count = enabledTools.length;
    const list = count > 0 ? enabledTools.join(", ") : "(none)";
    // JSON.stringify quotes and escapes the description so an embedded quote or
    // newline can't make the summary line ambiguous or wrap onto another line.
    const label =
      description !== undefined ? `${id} — ${JSON.stringify(description)}` : id;
    return `  ${label} (${count} tool${count === 1 ? "" : "s"}): ${list}`;
  });
  return [
    `${entries.length} connection${entries.length === 1 ? "" : "s"} configured:`,
    "",
    ...lines,
  ].join("\n");
}
