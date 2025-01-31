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

const readFlinkStatementArguments = z.object({
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
  timeoutInMilliseconds: z
    .number()
    .optional()
    .describe(
      "The function implements pagination. It will continue to fetch results using the next page token until either there are no more results or the timeout is reached. Tables backed by kafka topics can be thought of as never-ending streams as data could be continuously produced in near real-time. Therefore, if you wish to sample values from a stream, you may want to set a timeout.",
    ),
});

export class ReadFlinkStatementHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const {
      timeoutInMilliseconds,
      statementName,
      environmentId,
      organizationId,
      baseUrl,
    } = readFlinkStatementArguments.parse(toolArguments);
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

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudFlinkEndpoint(baseUrl);
    }
    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudFlinkRestClient(),
    );
    let allResults: unknown[] = [];
    let nextToken: string | undefined = undefined;
    const timeout =
      timeoutInMilliseconds === -1 || timeoutInMilliseconds === undefined
        ? undefined
        : Date.now() + timeoutInMilliseconds;

    /**
     * A timeout period has elapsed if a timeout is defined and the current time has exceeded it,
     * `false` otherwise.
     */
    const hasTimedOut = () => timeout !== undefined && Date.now() >= timeout;

    do {
      const { data: response, error } = await pathBasedClient[
        "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{name}/results"
      ].GET({
        params: {
          path: {
            organization_id: organization_id,
            environment_id: environment_id,
            name: statementName,
          },
          // only include the page token if it's defined
          ...(nextToken ? { query: { page_token: nextToken } } : {}),
        },
      });

      if (error) {
        return this.createResponse(
          `Failed to read Flink SQL statement: ${JSON.stringify(error)}`,
        );
      }

      allResults = allResults.concat(response?.results.data || []);
      nextToken = response?.metadata.next?.split("page_token=")[1];
    } while (nextToken && !hasTimedOut());

    return this.createResponse(
      `Flink SQL Statement Results: ${JSON.stringify(allResults)}`,
    );
  }
  getToolConfig(): ToolConfig {
    return {
      name: ToolName.READ_FLINK_STATEMENT,
      description: "Make a request to read a statement and its results",
      inputSchema: readFlinkStatementArguments.shape,
    };
  }
}
