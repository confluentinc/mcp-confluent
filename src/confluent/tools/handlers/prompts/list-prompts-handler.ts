import { z } from "zod";
import { PromptFactory } from "@src/confluent/prompts/prompt-factory.js";
import { BaseToolHandler } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { CallToolResult } from "@src/confluent/schema.js";

/**
 * Handler for listing all available prompts
 */
export class ListPromptsHandler extends BaseToolHandler {
  constructor() {
    super();
  }

  getToolConfig() {
    return {
      name: ToolName.LIST_PROMPTS,
      description: "List all available prompts in the Confluent MCP server",
      inputSchema: z.object({}).shape,
    };
  }

  async handle(): Promise<CallToolResult> {
    try {
      const promptMetadata = PromptFactory.getPromptMetadata();
      const message = JSON.stringify({ prompts: promptMetadata }, null, 2);
      return this.createResponse(message);
    } catch (error) {
      return this.createResponse(`Error fetching prompts: ${error}`, true);
    }
  }
}
