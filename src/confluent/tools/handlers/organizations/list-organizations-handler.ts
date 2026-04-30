import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import {
  connectionIdsWhere,
  hasConfluentCloud,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const listOrganizationsArguments = z.object({});

/**
 * Schema for validating Confluent Cloud organization responses
 * from `GET /org/v2/organizations`.
 */
export const organizationSchema = z.object({
  api_version: z.literal("org/v2"),
  kind: z.literal("Organization"),
  id: z.string(),
  metadata: z.object({
    created_at: z.string(),
    updated_at: z.string(),
    resource_name: z.string(),
    self: z.string().url(),
  }),
  display_name: z.string(),
  jit_enabled: z.boolean().optional(),
});

export const organizationListSchema = z.object({
  api_version: z.literal("org/v2"),
  kind: z.literal("OrganizationList"),
  data: z.array(organizationSchema),
});

export type Organization = z.infer<typeof organizationSchema>;
export type OrganizationList = z.infer<typeof organizationListSchema>;

export class ListOrganizationsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    listOrganizationsArguments.parse(toolArguments ?? {});

    try {
      const pathBasedClient = wrapAsPathBasedClient(
        clientManager.getConfluentCloudRestClient(),
      );

      const { data: response, error } = await pathBasedClient[
        "/org/v2/organizations"
      ].GET({});

      if (error) {
        logger.error({ error }, "API Error");
        return this.createResponse(
          `Failed to fetch organizations: ${JSON.stringify(error)}`,
          true,
          { error },
        );
      }

      const validated = organizationListSchema.parse(response);
      const organizations = validated.data.map((org) => ({
        id: org.id,
        name: org.display_name,
        resource_name: org.metadata.resource_name,
        created_at: org.metadata.created_at,
        updated_at: org.metadata.updated_at,
      }));

      const orgDetails = organizations
        .map(
          (org) => `
Organization: ${org.name}
  ID: ${org.id}
  Resource Name: ${org.resource_name}
  Created At: ${org.created_at}
  Updated At: ${org.updated_at}
`,
        )
        .join("\n");

      return this.createResponse(
        `Successfully retrieved ${organizations.length} organizations:\n${orgDetails}`,
        false,
        { organizations },
      );
    } catch (error) {
      logger.error({ error }, "Error in ListOrganizationsHandler");
      const message = error instanceof Error ? error.message : String(error);
      return this.createResponse(
        `Failed to fetch organizations: ${message}`,
        true,
        { error: message },
      );
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_ORGANIZATIONS,
      description:
        "Get all Confluent Cloud organizations the current credentials have access to",
      inputSchema: listOrganizationsArguments.shape,
      annotations: READ_ONLY,
    };
  }

  /**
   * Server-wide OAuth (`ccloudOAuth`) makes every connection cloud-eligible
   * regardless of its api_key blocks; absent OAuth, falls back to the
   * `hasConfluentCloud` per-connection predicate.
   */
  enabledConnectionIds(runtime: ServerRuntime): string[] {
    if (runtime.config.getCCloudOAuth() !== undefined) {
      return Object.keys(runtime.config.connections);
    }
    return connectionIdsWhere(runtime.config.connections, hasConfluentCloud);
  }
}
