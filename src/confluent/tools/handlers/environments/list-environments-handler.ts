import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import env from "@src/env.js";
import { logger } from "@src/logger.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const listEnvironmentsArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Confluent Cloud REST API.")
    .url()
    .default(() => env.CONFLUENT_CLOUD_REST_ENDPOINT ?? "")
    .optional(),
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
    self: z.string().url(),
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
      first: z.string().url().optional(),
      last: z.string().url().optional(),
      prev: z.string().url().optional(),
      next: z.string().url().optional(),
      total_size: z.number().optional(),
    })
    .optional(),
  data: z.array(environmentSchema),
});

export type Environment = z.infer<typeof environmentSchema>;
export type EnvironmentList = z.infer<typeof environmentListSchema>;

export class ListEnvironmentsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { baseUrl, pageToken } =
      listEnvironmentsArguments.parse(toolArguments);

    try {
      if (baseUrl !== undefined && baseUrl !== "") {
        clientManager.setConfluentCloudRestEndpoint(baseUrl);
      }

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

      try {
        const validatedResponse = environmentListSchema.parse(
          response,
        ) as EnvironmentList;
        const environments = validatedResponse.data.map((env) => ({
          id: env.id,
          name: env.display_name,
          created_at: env.metadata.created_at,
          updated_at: env.metadata.updated_at,
          deleted_at: env.metadata.deleted_at,
          resource_name: env.metadata.resource_name,
          stream_governance: env.stream_governance_config?.package,
        }));

        // Format environment details for display
        const environmentDetails = environments
          .map(
            (env) => `
Environment: ${env.name}
  ID: ${env.id}
  Resource Name: ${env.resource_name}
  Created At: ${env.created_at}
  Updated At: ${env.updated_at}${env.deleted_at ? `\n  Deleted At: ${env.deleted_at}` : ""}${env.stream_governance ? `\n  Stream Governance Package: ${env.stream_governance}` : ""}
`,
          )
          .join("\n");

        const metadata = validatedResponse.metadata;
        const paginationInfo = metadata
          ? `
Pagination:${metadata.total_size ? `\n  Total Environments: ${metadata.total_size}` : ""}${metadata.first ? `\n  First Page: ${metadata.first}` : ""}${metadata.last ? `\n  Last Page: ${metadata.last}` : ""}${metadata.prev ? `\n  Previous Page: ${metadata.prev}` : ""}${metadata.next ? `\n  Next Page: ${metadata.next}` : ""}
`
          : "";

        return this.createResponse(
          `Successfully retrieved ${environments.length} environments:\n${environmentDetails}\n${paginationInfo}`,
          false,
          {
            environments,
            total: metadata?.total_size,
            pagination: metadata
              ? {
                  first: metadata.first,
                  last: metadata.last,
                  prev: metadata.prev,
                  next: metadata.next,
                }
              : undefined,
          },
        );
      } catch (validationError) {
        logger.error(
          { error: validationError },
          "Environment list validation error",
        );
        return this.createResponse(
          `Invalid environment list data: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
          true,
          { error: validationError },
        );
      }
    } catch (error) {
      logger.error({ error }, "Error in ListEnvironmentsHandler");
      return this.createResponse(
        `Failed to fetch environments: ${error instanceof Error ? error.message : String(error)}`,
        true,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_ENVIRONMENTS,
      description:
        "Get all environments in Confluent Cloud with pagination support",
      inputSchema: listEnvironmentsArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["CONFLUENT_CLOUD_API_KEY", "CONFLUENT_CLOUD_API_SECRET"];
  }
}
