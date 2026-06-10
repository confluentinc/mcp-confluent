import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
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
import type { ZodRawShape } from "zod";

/**
 * Minimal concrete BaseToolHandler for use in tests.
 * Pass `enabled = false` to simulate a handler that disables itself for all
 * connections. The disabled-state reason is an arbitrary placeholder
 * (`MissingFlinkBlock`); tests check whether the tool is filtered out, not
 * which reason was reported. Uses ToolName.LIST_TOPICS as a placeholder —
 * any declared ToolName would do. `category` defaults to `ToolCategory.Kafka`;
 * pass an explicit value when a test needs to distinguish multiple stubs
 * by category (e.g., the `buildToolGatingReport` category-axis tests).
 *
 * Pass an explicit `predicate` to gate the stub on real connection attributes
 * (e.g. `hasKafka`) rather than the binary `enabled` toggle — needed by tests
 * that vary which connections a tool is viable for. Pass `inputSchema` to give
 * the stub a non-empty authored schema (e.g. for `getRegisteredToolConfig`
 * tests that assert the augmented schema preserves pre-existing fields). Pass
 * `annotations` to vary the stub's mutation posture (e.g. `CREATE_UPDATE` /
 * `DESTRUCTIVE`) — needed by the read-only verdict-overlay tests; defaults to
 * `READ_ONLY`.
 */
export class StubHandler extends BaseToolHandler {
  readonly category: ToolCategory;
  readonly predicate: ConnectionPredicate;
  private readonly authoredInputSchema: ZodRawShape;
  private readonly annotations: ToolAnnotations;

  constructor({
    enabled = true,
    category = ToolCategory.Kafka,
    predicate,
    inputSchema = {},
    annotations = READ_ONLY,
  }: {
    enabled?: boolean;
    category?: ToolCategory;
    predicate?: ConnectionPredicate;
    inputSchema?: ZodRawShape;
    annotations?: ToolAnnotations;
  } = {}) {
    super();
    this.category = category;
    this.authoredInputSchema = inputSchema;
    this.annotations = annotations;
    this.predicate =
      predicate ??
      (enabled
        ? alwaysEnabled
        : () => ({
            enabled: false,
            reason: ToolDisabledReason.MissingFlinkBlock,
          }));
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_TOPICS,
      description: "stub",
      inputSchema: this.authoredInputSchema,
      annotations: this.annotations,
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
