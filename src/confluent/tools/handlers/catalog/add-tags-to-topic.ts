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

const addTagToTopicArguments = z.object({
  baseUrl: z
    .string()
    .describe("The base URL of the Schema Registry REST API.")
    .url()
    .default(() => env.SCHEMA_REGISTRY_ENDPOINT ?? "")
    .optional(),
  tagAssignments: z
    .array(
      z.object({
        entityType: z.string().default("kafka_topic"),
        entityName: z
          .string()
          .describe(
            `Qualified name of the entity. If not provided, you can obtain it from using the ${ToolName.SEARCH_TOPICS_BY_NAME} tool. example: "lsrc-g2p81:lkc-xq8k7g:my-flights"`,
          ),
        typeName: z.string().describe("Name of the tag to assign"),
      }),
    )
    .nonempty()
    .describe("Array of tag assignments to create"),
});

export class AddTagToTopicHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { tagAssignments, baseUrl } =
      addTagToTopicArguments.parse(toolArguments);

    if (baseUrl !== undefined && baseUrl !== "") {
      clientManager.setConfluentCloudSchemaRegistryEndpoint(baseUrl);
    }

    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
    );

    const { data: response, error } = await pathBasedClient[
      "/catalog/v1/entity/tags"
    ].POST({
      body: tagAssignments,
    });

    if (error) {
      return this.createResponse(
        `Failed to assign tag: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Successfully assigned tag: ${JSON.stringify(response)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.ADD_TAGS_TO_TOPIC,
      description: "Assign existing tags to Kafka topics in Confluent Cloud.",
      inputSchema: addTagToTopicArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["SCHEMA_REGISTRY_API_KEY", "SCHEMA_REGISTRY_API_SECRET"];
  }
}
