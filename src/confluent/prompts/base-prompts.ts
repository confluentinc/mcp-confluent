import { ClientManager } from "@src/confluent/client-manager.js";
import { PromptName } from "@src/confluent/prompts/prompt-name.js";
import { EnvVar } from "@src/env-schema.js";
import { ZodRawShape, ZodType } from "zod";

export interface PromptHandler {
  handle(
    clientManager: ClientManager,
    promptArguments: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<PromptResult> | PromptResult;

  getPromptConfig(): PromptConfig;

  /**
   * Returns the Zod schema for validating prompt arguments.
   * This is used to parse and validate input arguments before processing.
   */
  getSchema(): ZodType<unknown>;

  /**
   * Returns an array of environment variables required for this prompt to function.
   *
   * This method is used to conditionally enable/disable prompts based on the availability
   * of required environment variables. Prompts will be disabled if any of their required
   * environment variables are not set.
   *
   * Example:
   * ```typescript
   * getRequiredEnvVars(): EnvVar[] {
   *   return [
   *     "KAFKA_API_KEY",
   *     "KAFKA_API_SECRET",
   *     "KAFKA_CLUSTER_ID"
   *   ];
   * }
   * ```
   *
   * @returns Array of environment variable names required by this prompt
   */
  getRequiredEnvVars(): EnvVar[];

  /**
   * Returns true if this prompt can only be used with Confluent Cloud REST APIs.
   * Override in subclasses for cloud-only prompts.
   */
  isConfluentCloudOnly(): boolean;
}

export interface PromptConfig {
  name: PromptName;
  description: string;
  inputSchema: ZodRawShape;
}

export interface PromptResult {
  content: PromptContent[];
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface PromptContent {
  type: "text" | "resource";
  text?: string;
  resource?: {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
  };
}

export abstract class BasePromptHandler implements PromptHandler {
  abstract handle(
    clientManager: ClientManager,
    promptArguments: Record<string, unknown> | undefined,
    sessionId?: string,
  ): Promise<PromptResult> | PromptResult;

  abstract getPromptConfig(): PromptConfig;

  abstract getSchema(): ZodType<unknown>;

  /**
   * Default implementation that returns an empty array, indicating no environment
   * variables are required. Override this method in your prompt handler if the prompt
   * requires specific environment variables to function.
   *
   * @returns Empty array by default
   */
  getRequiredEnvVars(): EnvVar[] {
    return [];
  }

  /**
   * Default implementation returns false, indicating the prompt is not Confluent Cloud only.
   * Override in subclasses for cloud-only prompts.
   */
  isConfluentCloudOnly(): boolean {
    return false;
  }

  createResponse(
    message: string,
    isError: boolean = false,
    _meta?: Record<string, unknown>,
  ): PromptResult {
    const response: PromptResult = {
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

  createResourceResponse(
    uri: string,
    name: string,
    description?: string,
    mimeType?: string,
    _meta?: Record<string, unknown>,
  ): PromptResult {
    const response: PromptResult = {
      content: [
        {
          type: "resource",
          resource: {
            uri,
            name,
            description,
            mimeType,
          },
        },
      ],
      _meta: _meta,
    };
    return response;
  }
}
