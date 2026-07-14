import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { hasConfluentCloudOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const listEnvironmentsArguments = z.object({
  pageToken: z
    .string()
    .optional()
    .describe("Token for the next page of environments"),
});

/**
 * Schema for validating Confluent Cloud environment responses
 */
export const environmentSchema = z.object({
  api_version: z.literal("org/v2"),
  kind: z.literal("Environment"),
  id: z.string(),
  metadata: z.object({
    created_at: z.string(),
    updated_at: z.string(),
    deleted_at: z.string().optional(),
    resource_name: z.string(),
    self: z.url(),
  }),
  display_name: z.string(),
  stream_governance_config: z
    .object({
      package: z.string(),
    })
    .optional(),
});

export const environmentListSchema = z.object({
  api_version: z.literal("org/v2"),
  kind: z.literal("EnvironmentList"),
  metadata: z
    .object({
      first: z.url().optional(),
      last: z.url().optional(),
      prev: z.url().optional(),
      next: z.url().optional(),
      total_size: z.number().optional(),
    })
    .optional(),
  data: z.array(environmentSchema),
});

export type Environment = z.infer<typeof environmentSchema>;
export type EnvironmentList = z.infer<typeof environmentListSchema>;

export class ListEnvironmentsHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { pageToken } = listEnvironmentsArguments.parse(toolArguments);
    const { clientManager } = this.resolveConnection(runtime, toolArguments);

    try {
      const pathBasedClient = wrapAsPathBasedClient(
        clientManager.getConfluentCloudRestClient(),
      );

      const { data: response, error } = await pathBasedClient[
        "/org/v2/environments"
      ].GET({
        params: {
          query: {
            page_token: pageToken,
          },
        },
      });

      if (error) {
        logger.error({ error }, "API Error");
        return this.createResponse(
          `Failed to fetch environments: ${JSON.stringify(error)}`,
          true,
          { error },
        );
      }

      return this.buildEnvironmentListResponse(response);
    } catch (error) {
      logger.error({ error }, "Error in ListEnvironmentsHandler");
      return this.createResponse(
        `Failed to fetch environments: ${errorMessage(error)}`,
        true,
        { error: errorMessage(error) },
      );
    }
  }

  /**
   * Validates the raw environment-list payload and renders the success response,
   * returning a validation-error response when the payload doesn't match the schema.
   */
  private buildEnvironmentListResponse(response: unknown): CallToolResult {
    let validatedResponse: EnvironmentList;
    try {
      validatedResponse = environmentListSchema.parse(response);
    } catch (validationError) {
      logger.error(
        { error: validationError },
        "Environment list validation error",
      );
      return this.createResponse(
        `Invalid environment list data: ${errorMessage(validationError)}`,
        true,
        { error: validationError },
      );
    }

    const environments = validatedResponse.data.map(toEnvironmentSummary);
    const metadata = validatedResponse.metadata;

    return this.createResponse(
      `Successfully retrieved ${environments.length} environments:\n${renderEnvironmentDetails(environments)}\n${renderPaginationInfo(metadata)}`,
      false,
      {
        environments,
        total: metadata?.total_size,
        pagination: toPaginationMeta(metadata),
      },
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_ENVIRONMENTS,
      description:
        "Get all environments in Confluent Cloud with pagination support",
      inputSchema: listEnvironmentsArguments.shape,
      annotations: READ_ONLY,
    };
  }
  readonly category = ToolCategory.ConfluentCloud;
  readonly predicate = hasConfluentCloudOrOAuth;
}

type EnvironmentListMetadata = EnvironmentList["metadata"];

/**
 * Flattened view of an environment for both the rendered text and the _meta payload.
 */
type EnvironmentSummary = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | undefined;
  resource_name: string;
  stream_governance: string | undefined;
};

/**
 * Extracts a message from an unknown throw/error value without assuming it is an Error.
 */
function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/**
 * Projects a validated environment onto the flat summary shape callers see.
 */
function toEnvironmentSummary(env: Environment): EnvironmentSummary {
  return {
    id: env.id,
    name: env.display_name,
    created_at: env.metadata.created_at,
    updated_at: env.metadata.updated_at,
    deleted_at: env.metadata.deleted_at,
    resource_name: env.metadata.resource_name,
    stream_governance: env.stream_governance_config?.package,
  };
}

/**
 * Renders the per-environment text block; deleted-at and stream-governance lines
 * appear only when populated.
 */
function renderEnvironmentDetails(environments: EnvironmentSummary[]): string {
  return environments
    .map((env) => {
      const deletedLine = env.deleted_at
        ? `\n  Deleted At: ${env.deleted_at}`
        : "";
      const governanceLine = env.stream_governance
        ? `\n  Stream Governance Package: ${env.stream_governance}`
        : "";
      return `
Environment: ${env.name}
  ID: ${env.id}
  Resource Name: ${env.resource_name}
  Created At: ${env.created_at}
  Updated At: ${env.updated_at}${deletedLine}${governanceLine}
`;
    })
    .join("\n");
}

/**
 * Renders the pagination text block. A present-but-empty metadata object still
 * emits the header; absent metadata emits nothing.
 */
function renderPaginationInfo(metadata: EnvironmentListMetadata): string {
  if (!metadata) {
    return "";
  }
  const links: Array<[string, string | number | undefined]> = [
    ["Total Environments", metadata.total_size],
    ["First Page", metadata.first],
    ["Last Page", metadata.last],
    ["Previous Page", metadata.prev],
    ["Next Page", metadata.next],
  ];
  const lines = links
    .filter(([, value]) => value)
    .map(([label, value]) => `\n  ${label}: ${value}`)
    .join("");
  return `
Pagination:${lines}
`;
}

/**
 * Builds the _meta pagination object, or undefined when no metadata was returned.
 */
function toPaginationMeta(metadata: EnvironmentListMetadata) {
  return metadata
    ? {
        first: metadata.first,
        last: metadata.last,
        prev: metadata.prev,
        next: metadata.next,
      }
    : undefined;
}
