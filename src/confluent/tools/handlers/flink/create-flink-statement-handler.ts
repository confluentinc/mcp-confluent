import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import env from "@src/env.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const createFlinkStatementArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Flink REST API.")
    .url()
    .default(env.FLINK_REST_ENDPOINT ?? "")
    .optional(),
  organizationId: z
    .string()
    .trim()
    .optional()
    .describe("The unique identifier for the organization."),
  environmentId: z
    .string()
    .trim()
    .optional()
    .describe("The unique identifier for the environment."),
  computePoolId: z
    .string()
    .trim()
    .optional()
    .describe("The id associated with the compute pool in context."),
  statement: z
    .string()
    .nonempty()
    .max(131072)
    .describe(
      "The raw Flink SQL text statement. Create table statements may not be necessary as topics in confluent cloud will be detected as created schemas. Make sure to show and describe tables before creating new ones.",
    ),
  statementName: z
    .string()
    .regex(
      new RegExp(
        "[a-z0-9]([-a-z0-9]*[a-z0-9])?(\\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*",
      ),
    )
    .nonempty()
    .max(100)
    .describe(
      "The user provided name of the resource, unique within this environment.",
    ),
  catalogName: z
    .string()
    .trim()
    .nonempty()
    .default(env["FLINK_ENV_NAME"] ?? "")
    .describe(
      "The catalog name to be used for the statement. Typically the confluent environment name.",
    ),
  databaseName: z
    .string()
    .trim()
    .nonempty()
    .default(env["KAFKA_CLUSTER_ID"] ?? "")
    .describe(
      "The database name to be used for the statement. Typically the Kafka cluster name.",
    ),
});

export class CreateFlinkStatementHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const {
      catalogName,
      databaseName,
      statement,
      statementName,
      computePoolId,
      environmentId,
      organizationId,
      baseUrl,
    } = createFlinkStatementArguments.parse(toolArguments);
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
    const compute_pool_id = getEnsuredParam(
      "FLINK_COMPUTE_POOL_ID",
      "Compute Pool ID is required",
      computePoolId,
    );

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudFlinkEndpoint(baseUrl);
    }

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudFlinkRestClient(),
    );
    const { data: response, error } = await pathBasedClient[
      "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements"
    ].POST({
      params: {
        path: {
          environment_id: environment_id,
          organization_id: organization_id,
        },
      },
      body: {
        name: statementName,
        organization_id: organization_id,
        environment_id: environment_id,
        spec: {
          compute_pool_id: compute_pool_id,
          statement: statement,
          properties: {
            // only include the catalog and database properties if they are defined
            ...(catalogName && { "sql.current-catalog": catalogName }),
            ...(databaseName && {
              "sql.current-database": databaseName,
            }),
          },
        },
      },
    });
    if (error) {
      return this.createResponse(
        `Failed to create Flink SQL statements: ${JSON.stringify(error)}`,
      );
    }
    return this.createResponse(`${JSON.stringify(response)}`);
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CREATE_FLINK_STATEMENT,
      description: "Make a request to create a statement.",
      inputSchema: createFlinkStatementArguments.shape,
    };
  }
}
