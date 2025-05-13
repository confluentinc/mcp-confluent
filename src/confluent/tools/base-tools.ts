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
  getRequiredEnvVars(): EnvVar[];
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
   * Default implementation that returns an empty array, indicating no environment
   * variables are required. Override this method in your tool handler if the tool
   * requires specific environment variables to function.
   *
   * @returns Empty array by default
   */
  getRequiredEnvVars(): EnvVar[] {
    return [];
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
