import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import { logger } from "@src/logger.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const deleteSchemaArguments = z.object({
  subject: z.string().describe("Name of the subject to delete.").nonempty(),
  version: z
    .string()
    .describe(
      'Version of the schema to delete. Valid values are between [1,2^31-1] or the string "latest". If omitted, all versions of the subject are deleted.',
    )
    .optional(),
  permanent: z
    .boolean()
    .describe(
      "Whether to perform a permanent (hard) delete. Default is false (soft delete).",
    )
    .default(false)
    .optional(),
});

export class DeleteSchemaHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { subject, version, permanent } =
      deleteSchemaArguments.parse(toolArguments);

    logger.debug(
      { subject, version, permanent },
      "DeleteSchemaHandler.handle called with arguments",
    );

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
    );

    if (version !== undefined) {
      const { response, error } = await pathBasedClient[
        "/subjects/{subject}/versions/{version}"
      ].DELETE({
        params: {
          path: { subject, version },
          query: { permanent },
        },
      });

      if (error) {
        logger.error(
          { subject, version, error },
          "Failed to delete schema version",
        );
        return this.createResponse(
          `Failed to delete schema version ${version} for subject "${subject}": ${JSON.stringify(error)}`,
          true,
        );
      }

      logger.info(
        { subject, version, status: response?.status },
        "Successfully deleted schema version",
      );
      return this.createResponse(
        `Successfully deleted version ${version} of subject "${subject}". Status: ${response?.status}`,
      );
    }

    const { response, error } = await pathBasedClient[
      "/subjects/{subject}"
    ].DELETE({
      params: {
        path: { subject },
        query: { permanent },
      },
    });

    if (error) {
      logger.error({ subject, error }, "Failed to delete subject");
      return this.createResponse(
        `Failed to delete subject "${subject}": ${JSON.stringify(error)}`,
        true,
      );
    }

    logger.info(
      { subject, status: response?.status },
      "Successfully deleted subject",
    );
    return this.createResponse(
      `Successfully deleted subject "${subject}". Status: ${response?.status}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DELETE_SCHEMA,
      description:
        "Delete a schema subject or a specific version from the Schema Registry. If version is omitted, all versions of the subject are deleted.",
      inputSchema: deleteSchemaArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["SCHEMA_REGISTRY_ENDPOINT"];
  }
}
