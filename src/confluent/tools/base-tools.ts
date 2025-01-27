import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult, ToolInput } from "@src/confluent/schema.js";

export enum ToolName {
  LIST_TOPICS = "list-topics",
  CREATE_TOPICS = "create-topics",
  DELETE_TOPICS = "delete-topics",
  PRODUCE_MESSAGE = "produce-message",
  LIST_FLINK_STATEMENTS = "list-flink-statements",
  CREATE_FLINK_STATEMENT = "create-flink-statement",
  READ_FLINK_STATEMENT = "read-flink-statement",
  DELETE_FLINK_STATEMENTS = "delete-flink-statements",
  LIST_CONNECTORS = "list-connectors",
  READ_CONNECTOR = "read-connector",
  CREATE_CONNECTOR = "create-connector",
}

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
