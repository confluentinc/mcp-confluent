import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  CCLOUD_SCHEMA_REGISTRY_REQUIRED_ENV_VARS,
  EnvVar,
} from "@src/env-schema.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const deleteTagArguments = z.object({
  tagName: z.string().describe("Name of the tag to delete").nonempty(),
});

export class DeleteTagHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { tagName } = deleteTagArguments.parse(toolArguments);

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
    );

    const { response, error } = await pathBasedClient[
      "/catalog/v1/types/tagdefs/{tagName}"
    ].DELETE({
      params: {
        path: {
          tagName: tagName,
        },
      },
    });

    if (error) {
      return this.createResponse(
        `Failed to delete tag: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Successfully deleted tag: ${tagName}. Status: ${response?.status}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.DELETE_TAG,
      description: "Delete a tag definition from Confluent Cloud.",
      inputSchema: deleteTagArguments.shape,
    };
  }

  getRequiredEnvVars(): readonly EnvVar[] {
    return CCLOUD_SCHEMA_REGISTRY_REQUIRED_ENV_VARS;
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
