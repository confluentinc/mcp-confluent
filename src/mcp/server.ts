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

const noopCaptureError = (): void => {};

export interface CreateMcpServerOptions {
  /** Surfaced via {@linkcode McpServer.server.getServerVersion}. */
  serverVersion: string;
  /** Each entry is registered as a tool on the new server instance. */
  toolHandlers: Map<ToolName, ToolHandler>;
  /** Injected into every {@linkcode ToolHandler.handle} invocation. */
  runtime: ServerRuntime;
  /** Per-tool-call telemetry hook. Defaults to a no-op. */
  track?: TrackToolCall;
  /** Reports a handler throw to crash reporting. Defaults to a no-op. */
  captureError?: (error: unknown, toolName: ToolName) => void;
}

/** Builds a fresh {@link McpServer} with every supplied {@linkcode ToolHandler} registered. */
export function createMcpServer({
  serverVersion,
  toolHandlers,
  runtime,
  track = noopTrack,
  captureError = noopCaptureError,
}: CreateMcpServerOptions): McpServer {
  const srv = new McpServer({
    name: "confluent",
    version: serverVersion,
  });

  toolHandlers.forEach((handler, name) => {
    const config = handler.getRegisteredToolConfig(runtime);

    srv.registerTool(
      name,
      {
        description: config.description,
        inputSchema: config.inputSchema,
        annotations: config.annotations,
        _meta: { category: handler.category },
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
          // Launch the browser OAuth login flow only when this call actually
          // routes to the OAuth connection — not merely because an OAuth
          // connection exists somewhere in the config. A call targeting a
          // local/direct connection in a mixed setup needs no login.
          const targetConnectionId = handler.resolvedTargetConnectionId(
            runtime,
            args,
          );
          if (
            runtime.oauthHolder !== undefined &&
            targetConnectionId !== undefined &&
            runtime.config.connections[targetConnectionId]?.type === "oauth"
          ) {
            await runtime.oauthHolder.ensureLoggedIn();
          }
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
          try {
            captureError(error, name);
          } catch {
            // Ignore crash-reporting failures to avoid masking the original tool error.
          }
          throw error;
        }
      },
    );
  });

  return srv;
}
