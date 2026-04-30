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

      try {
        const validated = organizationListSchema.parse(
          response,
        ) as OrganizationList;
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
      } catch (validationError) {
        logger.error(
          { error: validationError },
          "Organization list validation error",
        );
        return this.createResponse(
          `Invalid organization list data: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
          true,
          { error: validationError },
        );
      }
    } catch (error) {
      logger.error({ error }, "Error in ListOrganizationsHandler");
      return this.createResponse(
        `Failed to fetch organizations: ${error instanceof Error ? error.message : String(error)}`,
        true,
        { error: error instanceof Error ? error.message : String(error) },
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
   * Enabled under either auth path:
   *   - When `runtime.config.getCCloudOAuth()` returns a config, OAuth is in
   *     effect server-wide and every connection is OAuth-eligible regardless
   *     of its api_key blocks. Return all connection ids.
   *   - Otherwise, fall back to the api_key path: enabled iff a connection
   *     carries a `confluent_cloud` block.
   *
   * The runtime-aware branching is inlined here intentionally. A future ticket
   * extracts this into a `cloudCapableConnectionIds(runtime)` helper and
   * migrates every cloud handler in one shot — this handler is the template.
   */
  enabledConnectionIds(runtime: ServerRuntime): string[] {
    if (runtime.config.getCCloudOAuth() !== undefined) {
      return Object.keys(runtime.config.connections);
    }
    return connectionIdsWhere(runtime.config.connections, hasConfluentCloud);
  }
}
