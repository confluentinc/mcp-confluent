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
   * Returns the IDs of connections that satisfy this tool's requirements.
   * A non-empty result means the tool is enabled; empty means disabled.
   *
   * Override in subclasses with typed connection predicates (issue-173 children).
   * The default shim in BaseToolHandler delegates to getRequiredEnvVars().
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
  abstract getRequiredEnvVars(): readonly EnvVar[];

  /**
   * Shim implementation: returns all connection IDs when every required env var is
   * present in runtime.env, otherwise returns [].
   * Override with typed connection predicates during issue-173 migration.
   */
  enabledConnectionIds(runtime: ServerRuntime): string[] {
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
