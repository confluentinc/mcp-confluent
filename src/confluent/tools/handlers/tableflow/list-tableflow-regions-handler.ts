import type { CallToolResult } from "@src/confluent/schema.js";
import type { ToolConfig } from "@src/confluent/tools/base-tools.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { TableflowToolHandler } from "@src/confluent/tools/handlers/tableflow/tableflow-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import type { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const listTableFlowRegionsArguments = z.object({
  cloud: z
    .string()
    .trim()
    .optional()
    .describe("Filter the results by exact match for cloud."),
  pageSize: z
    .number()
    .int()
    .positive()
    .max(100)
    .optional()
    .describe(
      "Maximum regions to return in this response (1-100). Server-side default applies if omitted.",
    ),
  pageToken: z
    .string()
    .optional()
    .describe(
      "Opaque pagination token from a previous response. Omit on first request.",
    ),
});

export class ListTableFlowRegionsHandler extends TableflowToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { cloud, pageSize, pageToken } =
      listTableFlowRegionsArguments.parse(toolArguments);

    const { clientManager } = this.resolveConnection(runtime, toolArguments);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudTableflowRestClient(),
    );

    const { data: response, error } = await pathBasedClient[
      "/tableflow/v1/regions"
    ].GET({
      params: {
        query: {
          cloud,
          page_size: pageSize,
          page_token: pageToken,
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to list Tableflow regions: ${JSON.stringify(error)}`,
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
      annotations: READ_ONLY,
    };
  }
}
