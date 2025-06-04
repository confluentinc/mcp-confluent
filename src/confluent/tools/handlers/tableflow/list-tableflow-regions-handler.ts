import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import env from "@src/env.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const listTableFlowRegionsArguments = z.object({
  baseUrl: z
    .string()
    .trim()
    .describe("The base url of the Tableflow REST API.")
    .url()
    .default(() => env.CONFLUENT_CLOUD_REST_ENDPOINT ?? "")
    .optional(),
  cloud: z
    .string()
    .trim()
    .optional()
    .describe("Filter the results by exact match for cloud."),
  pageSize: z
    .string()
    .trim()
    .optional()
    .default("10")
    .describe("The pagination size of collection requests."),
  pageToken: z
    .string()
    .trim()
    .optional()
    .default("0")
    .describe("An opaque pagination token for collection requests."),
});

export class ListTableFlowRegionsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { cloud, baseUrl } =
      listTableFlowRegionsArguments.parse(toolArguments);

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudTableflowRestEndpoint(baseUrl);
    }

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudTableflowRestClient(),
    );

    const { data: response, error } = await pathBasedClient[
      `/tableflow/v1/regions?cloud=${cloud}`
    ].GET({
      params: {
        path: {
          cloud: cloud,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to list Tableflow regions for  ${cloud}: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Tableflow Regions: ${JSON.stringify(response)}`,
    );
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_TABLEFLOW_REGIONS,
      description: `Retrieve a sorted, filtered, paginated list of all tableflow regions.`,
      inputSchema: listTableFlowRegionsArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["TABLEFLOW_API_KEY", "TABLEFLOW_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
