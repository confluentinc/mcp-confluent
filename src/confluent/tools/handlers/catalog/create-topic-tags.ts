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

const createTagsArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Schema Registry REST API.")
    .url()
    .default(() => env.SCHEMA_REGISTRY_ENDPOINT ?? "")
    .optional(),
  tags: z
    .array(
      z.object({
        tagName: z.string().describe("Name of the tag to create").nonempty(),
        description: z
          .string()
          .describe("Description for the tag")
          .default("Tag created via API"),
      }),
    )
    .nonempty()
    .describe("Array of tag definitions to create"),
});

export class CreateTopicTagsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { tags, baseUrl } = createTagsArguments.parse(toolArguments);

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudSchemaRegistryEndpoint(baseUrl);
    }

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
    );

    const tagDefinitions = tags.map((tag) => ({
      entityTypes: ["kafka_topic"],
      name: tag.tagName,
      description: tag.description,
    }));

    const { data: response, error } = await pathBasedClient[
      "/catalog/v1/types/tagdefs"
    ].POST({
      body: tagDefinitions,
    });

    if (error) {
      return this.createResponse(
        `Failed to create tag: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Successfully created tag: ${JSON.stringify(response)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CREATE_TOPIC_TAGS,
      description: "Create new tag definitions in Confluent Cloud.",
      inputSchema: createTagsArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["SCHEMA_REGISTRY_API_KEY", "SCHEMA_REGISTRY_API_SECRET"];
  }
}
