import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult, ToolInput } from "@src/confluent/schema.js";
import { ToolName } from "./tool-name.js";

export interface ToolHandler {
  handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> | CallToolResult;

  getToolConfig(): ToolConfig;
}

export interface ToolConfig {
  name: ToolName;
  description: string;
  inputSchema: ToolInput;
}

export abstract class BaseToolHandler implements ToolHandler {
  abstract handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> | CallToolResult;

  abstract getToolConfig(): ToolConfig;

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
