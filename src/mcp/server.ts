import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";

/** Properties recorded for each tool invocation. */
export interface ToolCallProps {
  toolName: ToolName;
  /** From {@linkcode McpServer.server.getClientVersion}, undefined pre-handshake. */
  clientName: string | undefined;
  /** From {@linkcode McpServer.server.getClientVersion}, undefined pre-handshake. */
  clientVersion: string | undefined;
  durationMs: number;
  status: "success" | "error";
}

/** Optional callback invoked once per tool call with timing + status. */
export type TrackToolCall = (props: ToolCallProps) => void;

const noopTrack: TrackToolCall = () => {};

export interface CreateMcpServerOptions {
  /** Surfaced via {@linkcode McpServer.server.getServerVersion}. */
  serverVersion: string;
  /** Each entry is registered as a tool on the new server instance. */
  toolHandlers: Map<ToolName, ToolHandler>;
  /** Injected into every {@linkcode ToolHandler.handle} invocation. */
  runtime: ServerRuntime;
  /** Per-tool-call telemetry hook. Defaults to a no-op. */
  track?: TrackToolCall;
}

/** Builds a fresh {@link McpServer} with every supplied {@linkcode ToolHandler} registered. */
export function createMcpServer({
  serverVersion,
  toolHandlers,
  runtime,
  track = noopTrack,
}: CreateMcpServerOptions): McpServer {
  const srv = new McpServer({
    name: "confluent",
    version: serverVersion,
  });

  toolHandlers.forEach((handler, name) => {
    const config = handler.getToolConfig();

    srv.registerTool(
      name,
      {
        description: config.description,
        inputSchema: config.inputSchema,
        annotations: config.annotations,
      },
      async (args, context) => {
        const startTime = Date.now();
        // per-instance lookup so concurrent HTTP sessions don't clobber each other's telemetry
        const clientInfo = srv.server.getClientVersion();
        const baseProps = {
          toolName: name,
          clientName: clientInfo?.name,
          clientVersion: clientInfo?.version,
        };
        try {
          const result = await handler.handle(
            runtime,
            args,
            context?.sessionId,
          );
          track({
            ...baseProps,
            durationMs: Date.now() - startTime,
            status: result.isError ? "error" : "success",
          });
          return result;
        } catch (error) {
          track({
            ...baseProps,
            durationMs: Date.now() - startTime,
            status: "error",
          });
          throw error;
        }
      },
    );
  });

  return srv;
}
