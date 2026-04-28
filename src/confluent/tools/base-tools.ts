import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
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
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<CallToolResult> | CallToolResult;

  getToolConfig(): ToolConfig;

  /**
   * Returns the IDs of connections that satisfy this tool's service requirements.
   * A non-empty result enables the tool; an empty result disables it. Implementations
   * should return a subset of the keys in runtime.config.connections.
   *
   * Each handler is intended to implement this by applying the appropriate predicate from
   * connection-predicates.ts via connectionIdsWhere(), e.g.:
   *   return connectionIdsWhere(runtime.config.connections, hasKafka);
   */
  enabledConnectionIds(runtime: ServerRuntime): string[];

  /**
   * Returns true if this tool can only be used with Confluent Cloud REST APIs.
   * Override in subclasses for cloud-only tools.
   */
  isConfluentCloudOnly(): boolean;
}

export interface ToolConfig {
  name: ToolName;
  description: string;
  inputSchema: ZodRawShape;
  annotations: ToolAnnotations;
}

export abstract class BaseToolHandler implements ToolHandler {
  abstract handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<CallToolResult> | CallToolResult;

  abstract getToolConfig(): ToolConfig;

  /**
   * Return the env var names required for this tool.
   * Used by the enabledConnectionIds() shim; replaced by typed connection predicates
   * when each handler migrates (issue-173 children). Remove once all handlers migrate.
   */
  protected getRequiredEnvVars(): readonly EnvVar[] {
    throw new Error(
      `${this.constructor.name} must override enabledConnectionIds() or implement getRequiredEnvVars()`,
    );
  }

  /**
   * Determines which configured connections can serve this tool by inspecting
   * their service blocks. If returns an empty array, the tool is disabled.
   *
   * The canonical implementation is a one-liner:
   *   return connectionIdsWhere(runtime.config.connections, some-predicate-function);
   */
  enabledConnectionIds(runtime: ServerRuntime): string[] {
    // Shim: delegates to getRequiredEnvVars() until all handlers migrate (issue-173).
    const missingVars = this.getRequiredEnvVars().filter(
      (varName) => !runtime.env[varName],
    );
    return missingVars.length === 0
      ? Object.keys(runtime.config.connections)
      : [];
  }

  /**
   * Default implementation returns false, indicating the tool is not Confluent Cloud only.
   * Override in subclasses for cloud-only tools.
   */
  isConfluentCloudOnly(): boolean {
    return false;
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
