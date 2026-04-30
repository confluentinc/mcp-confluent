import type { ClientManager } from "@src/confluent/client-manager.js";
import type { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  type ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import type { ServerRuntime } from "@src/server-runtime.js";

/**
 * Minimal concrete BaseToolHandler for use in tests.
 * Pass `enabled = false` to simulate a handler that disables itself for all connections.
 * Uses ToolName.LIST_TOPICS as a placeholder — any declared ToolName would do.
 */
export class StubHandler extends BaseToolHandler {
  private readonly enabled: boolean;

  constructor({ enabled = true }: { enabled?: boolean } = {}) {
    super();
    this.enabled = enabled;
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_TOPICS,
      description: "stub",
      inputSchema: {},
      annotations: READ_ONLY,
    };
  }

  handle(
    _clientManager: ClientManager,
    _toolArguments: Record<string, unknown> | undefined,
    _sessionId?: string,
  ): CallToolResult {
    return this.createResponse("stub");
  }

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return this.enabled ? Object.keys(runtime.config.connections) : [];
  }
}
