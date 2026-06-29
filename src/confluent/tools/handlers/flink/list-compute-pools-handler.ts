import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { resolveEnvArg } from "@src/confluent/tools/cluster-arg-resolvers.js";
import { hasConfluentCloudOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const listComputePoolsArguments = z.object({
  environmentId: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the compute pools. Discover via list-environments",
    ),
});

/**
 * Schema for validating Confluent Cloud Flink compute pool responses.
 * Only the fields the regional Flink URL resolver consumes are pinned; the rest
 * of the FCPM payload is ignored.
 */
export const computePoolSchema = z.object({
  id: z.string(),
  spec: z.object({
    display_name: z.string(),
    cloud: z.string(),
    region: z.string(),
  }),
});

export type ComputePool = z.infer<typeof computePoolSchema>;

export class ListComputePoolsHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { environmentId } = listComputePoolsArguments.parse(
      toolArguments ?? {},
    );
    const { connId, clientManager } = this.resolveConnection(
      runtime,
      toolArguments,
    );
    const resolvedEnv = resolveEnvArg({ environmentId }, runtime, connId);

    try {
      const pathBasedClient = wrapAsPathBasedClient(
        clientManager.getConfluentCloudRestClient(),
      );

      const { data: response, error } = await pathBasedClient[
        "/fcpm/v2/compute-pools"
      ].GET({
        params: {
          query: {
            environment: resolvedEnv,
            page_size: 100,
          },
        },
      });

      if (error) {
        logger.error({ error }, "API Error");
        return this.createResponse(
          `Failed to fetch compute pools: ${JSON.stringify(error)}`,
          true,
          { error },
        );
      }

      if (!response || typeof response !== "object") {
        return this.createResponse(
          "Invalid response format: response is not an object",
          true,
          { response },
        );
      }

      if (!Array.isArray(response.data)) {
        return this.createResponse(
          "Invalid response format: missing or invalid data array",
          true,
          { response },
        );
      }

      const computePools = response.data.map((pool: unknown) => {
        try {
          const validatedPool = computePoolSchema.parse(pool) as ComputePool;
          return {
            id: validatedPool.id,
            name: validatedPool.spec.display_name,
            cloud: validatedPool.spec.cloud,
            region: validatedPool.spec.region,
          };
        } catch (validationError) {
          logger.error(
            { error: validationError },
            "Compute pool validation error",
          );
          throw new Error(
            `Invalid compute pool data: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
          );
        }
      });

      const poolDetails = computePools
        .map(
          (pool) => `
Compute Pool: ${pool.name}
  ID: ${pool.id}
  Cloud: ${pool.cloud}
  Region: ${pool.region}
`,
        )
        .join("\n");

      return this.createResponse(
        `Successfully retrieved ${computePools.length} compute pools:\n${poolDetails}`,
        false,
        { computePools, total: response.metadata?.total_size },
      );
    } catch (error) {
      logger.error({ error }, "Error in ListComputePoolsHandler");
      return this.createResponse(
        `Failed to fetch compute pools: ${error instanceof Error ? error.message : String(error)}`,
        true,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_COMPUTE_POOLS,
      description:
        "Get all Flink compute pools in the Confluent Cloud environment",
      inputSchema: listComputePoolsArguments.shape,
      annotations: READ_ONLY,
    };
  }
  readonly category = ToolCategory.Flink;
  readonly predicate = hasConfluentCloudOrOAuth;
}
