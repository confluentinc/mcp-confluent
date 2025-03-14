import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import env from "@src/env.js";
import { z } from "zod";

const listEnvironmentsArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Confluent Cloud REST API.")
    .url()
    .default(env.CONFLUENT_CLOUD_REST_ENDPOINT ?? "")
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
      const url = new URL(`org/v2/environments`, baseUrl);

      if (pageToken) {
        url.searchParams.append("page_token", pageToken);
      }

      // MCP server log
      await this.createResponse(`Making request to: ${url.toString()}`, false, {
        requestUrl: url.toString(),
      });

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Basic ${Buffer.from(`${env.CONFLUENT_CLOUD_API_KEY}:${env.CONFLUENT_CLOUD_API_SECRET}`).toString("base64")}`,
          "Content-Type": "application/json",
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("API Error:", {
          status: response.status,
          statusText: response.statusText,
          error: errorText,
        });
        return this.createResponse(
          `Failed to fetch environments using ${url.toString()}: ${response.status} ${response.statusText}\nResponse: ${errorText}`,
          true,
          { status: response.status, statusText: response.statusText },
        );
      }

      let data;
      try {
        const responseText = await response.text();

        try {
          data = JSON.parse(responseText);
        } catch (jsonError) {
          console.error("JSON Parse Error:", jsonError);
          if (
            typeof responseText === "string" &&
            responseText.startsWith("{")
          ) {
            try {
              data = JSON.parse(responseText);
            } catch (secondError: unknown) {
              throw new Error(
                `Failed to parse response as JSON: ${secondError instanceof Error ? secondError.message : String(secondError)}`,
              );
            }
          } else {
            throw new Error(`Invalid JSON response: ${responseText}`);
          }
        }
      } catch (parseError) {
        console.error("Response Parse Error:", parseError);
        return this.createResponse(
          `Failed to parse API response: ${parseError instanceof Error ? parseError.message : String(parseError)}`,
          true,
          {
            parseError:
              parseError instanceof Error
                ? parseError.message
                : String(parseError),
          },
        );
      }

      try {
        const validatedResponse = environmentListSchema.parse(
          data,
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
        console.error("Environment list validation error:", validationError);
        return this.createResponse(
          `Invalid environment list data: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
          true,
          { error: validationError },
        );
      }
    } catch (error) {
      console.error("Error in ListEnvironmentsHandler:", error);
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
}
