// Factory for registering and retrieving prompts, similar to ToolFactory
import { reportClusterUsagePrompt } from "./report-cluster-usage-prompt.js";
// Import additional prompts here as you add them

export type Prompt = typeof reportClusterUsagePrompt;

export interface PromptMetadata {
  name: string;
  description: string;
  arguments: {
    name: string;
    description: string;
    required?: boolean;
  }[];
}

export class PromptFactory {
  private static prompts: Map<string, Prompt> = new Map([
    [reportClusterUsagePrompt.name, reportClusterUsagePrompt],
    // Add more prompts here
  ]);

  public static getPrompt(name: string): Prompt | undefined {
    return this.prompts.get(name);
  }

  public static getPrompts(): Map<string, Prompt> {
    return this.prompts;
  }

  public static getPromptMetadata(): PromptMetadata[] {
    return Array.from(this.prompts.values()).map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments || [],
    }));
  }
}
