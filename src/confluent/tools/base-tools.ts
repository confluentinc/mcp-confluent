import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  ConnectionPredicate,
  PredicateResult,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { ZodRawShape } from "zod";

/**
 * Standard MCP tool annotations.
 * Tools should reference these constants rather than creating ad-hoc instances.
 */
export const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
} as const;

export const CREATE_UPDATE: ToolAnnotations = {
  destructiveHint: false,
  readOnlyHint: false,
} as const;

export const DESTRUCTIVE: ToolAnnotations = {
  destructiveHint: true,
  readOnlyHint: false,
} as const;

export interface ToolHandler {
  handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<CallToolResult> | CallToolResult;

  getToolConfig(): ToolConfig;

  /**
   * IDs of connections that satisfy this tool's service requirements. A
   * non-empty result enables the tool; an empty result disables it. Always a
   * subset of `runtime.config.connections` keys.
   */
  enabledConnectionIds(runtime: ServerRuntime): string[];

  /**
   * Per-connection verdict map for this tool: `{ enabled: true }` for
   * connections that satisfy its requirements, `{ enabled: false; reason }`
   * for those that don't. Powers startup-log grouping and the
   * `describe-tool-availability` diagnostic tool.
   */
  connectionVerdicts(runtime: ServerRuntime): Map<string, PredicateResult>;
}

export interface ToolConfig {
  name: ToolName;
  description: string;
  inputSchema: ZodRawShape;
  annotations: ToolAnnotations;
}

export abstract class BaseToolHandler implements ToolHandler {
  abstract handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<CallToolResult> | CallToolResult;

  abstract getToolConfig(): ToolConfig;

  /**
   * The connection predicate that gates this tool. Subclasses declare it as
   * a readonly property; {@linkcode enabledConnectionIds} and
   * {@linkcode connectionVerdicts} are derived from it. Use a
   * predicate from `connection-predicates.ts` (e.g. `hasKafka`), or compose
   * with `allOf(...)` for compound requirements; use `alwaysEnabled` for
   * tools with no service-block requirement.
   */
  abstract readonly predicate: ConnectionPredicate;

  /**
   * IDs of connections that satisfy this tool's {@linkcode predicate}. A
   * non-empty result enables the tool; an empty result disables it.
   *
   * Customize tool gating by declaring {@linkcode predicate}, never by
   * replacing this derivation.
   *
   * @final — concrete on `BaseToolHandler`; subclasses must not override.
   */
  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return Object.entries(runtime.config.connections)
      .filter(([, conn]) => this.predicate(conn).enabled)
      .map(([id]) => id);
  }

  /**
   * Per-connection verdict map for this tool, derived from
   * {@linkcode predicate}. Powers grouped startup logging and
   * the diagnostic-tool surface.
   *
   * Customize tool gating by declaring {@linkcode predicate}, never by
   * replacing this derivation.
   *
   * @final — concrete on `BaseToolHandler`; subclasses must not override.
   */
  connectionVerdicts(runtime: ServerRuntime): Map<string, PredicateResult> {
    return new Map(
      Object.entries(runtime.config.connections).map(([id, conn]) => [
        id,
        this.predicate(conn),
      ]),
    );
  }

  /**
   * Resolves a required string from an explicit tool argument, falling back to
   * a connection-config value. Throws if neither is present.
   * `label` is the human-readable field name (e.g. `"Organization ID"`);
   * the thrown message is `"${label} is required"`.
   * The returned value is always trimmed.
   */
  protected resolveParam(
    argValue: string | undefined,
    configValue: string | undefined,
    label: string,
  ): string {
    const resolved = argValue?.trim() || configValue?.trim();
    if (!resolved) throw new Error(`${label} is required`);
    return resolved;
  }

  /** Like resolveParam but returns undefined instead of throwing when both are absent or blank. The returned value is always trimmed. */
  protected resolveOptionalParam(
    argValue: string | undefined,
    configValue: string | undefined,
  ): string | undefined {
    return argValue?.trim() || configValue?.trim() || undefined;
  }

  createResponse(
    message: string,
    isError: boolean = false,
    _meta?: Record<string, unknown>, // Type as a generic object
  ): CallToolResult {
    const response: CallToolResult = {
      content: [
        {
          type: "text",
          text: message,
        },
      ],
      isError: isError,
      _meta: _meta,
    };
    return response;
  }
}
