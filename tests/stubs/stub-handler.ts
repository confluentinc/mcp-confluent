import type { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
  type ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  ConnectionPredicate,
  ToolDisabledReason,
  alwaysEnabled,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import type { ServerRuntime } from "@src/server-runtime.js";

/**
 * Minimal concrete BaseToolHandler for use in tests.
 * Pass `enabled = false` to simulate a handler that disables itself for all
 * connections. The disabled-state reason is an arbitrary placeholder
 * (`MissingFlinkBlock`); tests check whether the tool is filtered out, not
 * which reason was reported. Uses ToolName.LIST_TOPICS as a placeholder —
 * any declared ToolName would do. `category` defaults to `ToolCategory.Kafka`;
 * pass an explicit value when a test needs to distinguish multiple stubs
 * by category (e.g., the `buildToolGatingReport` category-axis tests).
 */
export class StubHandler extends BaseToolHandler {
  readonly category: ToolCategory;
  readonly predicate: ConnectionPredicate;

  constructor({
    enabled = true,
    category = ToolCategory.Kafka,
  }: { enabled?: boolean; category?: ToolCategory } = {}) {
    super();
    this.category = category;
    this.predicate = enabled
      ? alwaysEnabled
      : () => ({
          enabled: false,
          reason: ToolDisabledReason.MissingFlinkBlock,
        });
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
    _runtime: ServerRuntime,
    _toolArguments: Record<string, unknown> | undefined,
    _sessionId?: string,
  ): CallToolResult {
    return this.createResponse("stub");
  }
}
