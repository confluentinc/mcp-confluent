import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import { ZodRawShape } from "zod";

export interface ToolHandler {
  handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<CallToolResult> | CallToolResult;

  getToolConfig(): ToolConfig;

  /**
   * Returns an array of environment variables required for this tool to function.
   *
   * This method is used to conditionally enable/disable tools based on the availability
   * of required environment variables. Tools will be disabled if any of their required
   * environment variables are not set.
   *
   *
   * Example:
   * ```typescript
   * getRequiredEnvVars(): EnvVar[] {
   *   return [
   *     "KAFKA_API_KEY",
   *     "KAFKA_API_SECRET",
   *     "BOOTSTRAP_SERVERS"
   *   ];
   * }
   * ```
   *
   * @returns Array of environment variable names required by this tool
   */
  getRequiredEnvVars(): readonly EnvVar[];

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
}

export abstract class BaseToolHandler implements ToolHandler {
  abstract handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<CallToolResult> | CallToolResult;

  abstract getToolConfig(): ToolConfig;

  /**
   * Return an array of environment variable names required for the operation of this tool.
   *
   * Preferable to return a constant array of EnvVars defined in src/env-schema.ts for easier determination
   * of which tools require which subset of env vars.
   *
   * If any required environment variables are not set at invocation time,
   * the tool will be disabled and not returned by the tool loader.
   */
  abstract getRequiredEnvVars(): readonly EnvVar[];

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
