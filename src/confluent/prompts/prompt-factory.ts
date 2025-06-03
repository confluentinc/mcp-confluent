import {
  PromptHandler,
  PromptConfig,
} from "@src/confluent/prompts/base-prompts.js";
import { PromptName } from "@src/confluent/prompts/prompt-name.js";
import { ReportClusterUsagePromptHandler } from "@src/confluent/prompts/handlers/report-cluster-usage-prompt-handler.js";

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
  private static promptHandlers: Map<PromptName, PromptHandler> = new Map([
    [PromptName.REPORT_CLUSTER_USAGE, new ReportClusterUsagePromptHandler()],
  ]);

  public static getPromptHandler(name: PromptName): PromptHandler | undefined {
    return this.promptHandlers.get(name);
  }

  public static getPromptHandlers(): Map<PromptName, PromptHandler> {
    return this.promptHandlers;
  }

  public static getPromptConfigs(): PromptConfig[] {
    return Array.from(this.promptHandlers.values()).map((handler) =>
      handler.getPromptConfig(),
    );
  }

  public static getPromptMetadata(): PromptMetadata[] {
    return Array.from(this.promptHandlers.values()).map((handler) => {
      const config = handler.getPromptConfig();
      return {
        name: config.name,
        description: config.description,
        arguments: config.arguments || [],
      };
    });
  }

  public static getPromptNames(): PromptName[] {
    return Array.from(this.promptHandlers.keys());
  }
}
