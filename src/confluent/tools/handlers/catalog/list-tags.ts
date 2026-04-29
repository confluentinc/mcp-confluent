import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasSchemaRegistry,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";

export class ListTagsHandler extends BaseToolHandler {
  async handle(clientManager: ClientManager): Promise<CallToolResult> {
    const pathBasedClient = wrapAsPathBasedClient(
      clientManager.getConfluentCloudSchemaRegistryRestClient(),
    );

    const { data: response, error } =
      await pathBasedClient["/catalog/v1/types/tagdefs"].GET();
    if (error) {
      return this.createResponse(
        `Failed to list tags: ${JSON.stringify(error)}`,
        true,
      );
    }
    return this.createResponse(
      `Successfully retrieved tags: ${JSON.stringify(response)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_TAGS,
      description:
        "Retrieve all tags with definitions from Confluent Cloud Schema Registry.",
      inputSchema: {},
      annotations: READ_ONLY,
    };
  }

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(runtime.config.connections, hasSchemaRegistry);
  }
}
