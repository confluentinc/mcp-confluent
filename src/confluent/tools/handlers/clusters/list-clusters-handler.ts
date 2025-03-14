import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import env from "@src/env.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const listClustersArguments = z.object({
  baseUrl: z
    .string()
    .trim()
    .describe("The base URL of the Confluent Cloud REST API.")
    .url()
    .default(env.CONFLUENT_CLOUD_REST_ENDPOINT ?? "")
    .optional(),
  environmentId: z
    .string()
    .optional()
    .describe("The environment ID to filter clusters by"),
});

/**
 * Schema for validating Confluent Cloud cluster responses
 * Used in the map function to validate and transform cluster data
 */
export const clusterSchema = z.object({
  api_version: z.string(),
  id: z.string(),
  kind: z.string(),
  metadata: z.object({
    created_at: z.string(),
    resource_name: z.string(),
    self: z.string(),
    updated_at: z.string(),
  }),
  spec: z.object({
    api_endpoint: z.string(),
    availability: z.string(),
    cloud: z.string(),
    config: z.object({
      cku: z.number().optional(),
      kind: z.string(),
      zones: z.array(z.string()).optional(),
    }),
    display_name: z.string(),
    environment: z.object({
      id: z.string(),
      related: z.string(),
      resource_name: z.string(),
    }),
    http_endpoint: z.string(),
    kafka_bootstrap_endpoint: z.string(),
    region: z.string(),
  }),
  status: z.object({
    cku: z.number().optional(),
    phase: z.string(),
  }),
});

export type Cluster = z.infer<typeof clusterSchema>;

export class ListClustersHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { environmentId, baseUrl } =
      listClustersArguments.parse(toolArguments);

    try {
      if (baseUrl !== undefined && baseUrl !== "") {
        clientManager.setConfluentCloudRestEndpoint(baseUrl);
      }

      const pathBasedClient = wrapAsPathBasedClient(
        clientManager.getConfluentCloudRestClient(),
      );

      const { data: response, error } = await pathBasedClient[
        "/cmk/v2/clusters"
      ].GET({
        params: {
          query: {
            environment: environmentId ?? env.KAFKA_ENV_ID ?? "",
            page_size: 100,
          },
        },
      });

      if (error) {
        console.error("API Error:", error);
        return this.createResponse(
          `Failed to fetch clusters: ${JSON.stringify(error)}`,
          true,
          { error },
        );
      }

      // Validate the response structure
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

      const clusters = response.data.map((cluster: unknown) => {
        try {
          const validatedCluster = clusterSchema.parse(cluster) as Cluster;
          return {
            id: validatedCluster.id,
            name: validatedCluster.spec.display_name,
            availability: validatedCluster.spec.availability,
            cloud: validatedCluster.spec.cloud,
            region: validatedCluster.spec.region,
            environmentId: validatedCluster.spec.environment.id,
            status: validatedCluster.status.phase,
            cku:
              validatedCluster.status.cku ??
              validatedCluster.spec.config.cku ??
              0,
            endpoints: {
              http: validatedCluster.spec.http_endpoint,
              bootstrap: validatedCluster.spec.kafka_bootstrap_endpoint,
            },
            config: {
              kind: validatedCluster.spec.config.kind,
              zones: validatedCluster.spec.config.zones ?? [],
            },
          };
        } catch (validationError) {
          console.error("Cluster validation error:", validationError);
          throw new Error(
            `Invalid cluster data: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
          );
        }
      });

      // Format cluster details for display
      const clusterDetails = clusters
        .map(
          (cluster) => `
Cluster: ${cluster.name}
  ID: ${cluster.id}
  Environment ID: ${cluster.environmentId}
  Status: ${cluster.status}
  Availability: ${cluster.availability}
  Cloud: ${cluster.cloud}
  Region: ${cluster.region}
  CKU: ${cluster.cku}
  Endpoints:
    HTTP: ${cluster.endpoints.http}
    Bootstrap: ${cluster.endpoints.bootstrap}
  Config:
    Kind: ${cluster.config.kind}
    Zones: ${cluster.config.zones.join(", ")}
`,
        )
        .join("\n");

      return this.createResponse(
        `Successfully retrieved ${clusters.length} clusters:\n${clusterDetails}`,
        false,
        { clusters, total: response.metadata?.total_size },
      );
    } catch (error) {
      console.error("Error in ListClustersHandler:", error);
      return this.createResponse(
        `Failed to fetch clusters: ${error instanceof Error ? error.message : String(error)}`,
        true,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_CLUSTERS,
      description: "Get all clusters in the Confluent Cloud environment",
      inputSchema: listClustersArguments.shape,
    };
  }
}
