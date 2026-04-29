import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import env from "@src/env.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const listFlinkStatementsArguments = z.object({
  organizationId: z
    .string()
    .optional()
    .describe("The unique identifier for the organization."),
  environmentId: z
    .string()
    .optional()
    .describe("The unique identifier for the environment."),
  computePoolId: z
    .string()
    .optional()
    .default(() => env.FLINK_COMPUTE_POOL_ID ?? "")
    .describe("Filter the results by exact match for compute_pool."),
  pageSize: z
    .number()
    .int()
    .nonnegative()
    .max(100)
    .default(100)
    .describe(
      "A pagination size for collection requests. Default is 100 (max).",
    ),
  pageToken: z
    .string()
    .max(255)
    .optional()
    .describe("An opaque pagination token for collection requests."),
  labelSelector: z
    .string()
    .optional()
    .describe("A comma-separated label selector to filter the statements."),
  statusPhase: z
    .string()
    .optional()
    .describe(
      "Filter by status phase: PENDING, RUNNING, COMPLETED, FAILED, STOPPED, etc.",
    ),
});

export class ListFlinkStatementsHandler extends FlinkToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const {
      pageSize,
      computePoolId,
      environmentId,
      labelSelector,
      organizationId,
      pageToken,
      statusPhase,
    } = listFlinkStatementsArguments.parse(toolArguments);
    const organization_id = getEnsuredParam(
      "FLINK_ORG_ID",
      "Organization ID is required",
      organizationId,
    );
    const environment_id = getEnsuredParam(
      "FLINK_ENV_ID",
      "Environment ID is required",
      environmentId,
    );

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudFlinkRestClient(),
    );
    const { data: response, error } = await pathBasedClient[
      "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements"
    ].GET({
      params: {
        path: {
          organization_id: organization_id,
          environment_id: environment_id,
        },
        query: {
          "spec.compute_pool_id": computePoolId,
          page_size: pageSize,
          page_token: pageToken,
          label_selector: labelSelector,
          ...(statusPhase && { "status.phase": [statusPhase] }),
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to list Flink SQL statements: ${JSON.stringify(error)}`,
        true,
      );
    }

    // Client-side filtering by status phase (server-side filter doesn't work reliably)
    if (statusPhase && response?.data) {
      const filteredData = response.data.filter(
        (statement: { status?: { phase?: string } }) =>
          statement.status?.phase === statusPhase,
      );
      const filteredResponse = {
        ...response,
        data: filteredData,
      };
      const paginationNote = response.metadata?.next
        ? `\nNote: Results are filtered client-side by status '${statusPhase}'. The count (${filteredData.length}) is from a filtered subset of page_size=${pageSize}. More results may be available — use page_token from metadata to fetch the next page.`
        : "";
      return this.createResponse(
        `Found ${filteredData.length} statement(s) with status '${statusPhase}':\n${JSON.stringify(filteredResponse)}${paginationNote}`,
      );
    }

    return this.createResponse(`${JSON.stringify(response)}`);
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_FLINK_STATEMENTS,
      description:
        "Retrieve a sorted, filtered, paginated list of all statements.",
      inputSchema: listFlinkStatementsArguments.shape,
      annotations: READ_ONLY,
    };
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
