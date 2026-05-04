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

const listOrganizationsArguments = z.object({
  pageSize: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      "Maximum organizations to return in this response. Server-side default applies if omitted.",
    ),
  pageToken: z
    .string()
    .optional()
    .describe(
      "Opaque pagination token from a previous response's _meta.nextPageToken. Omit on first request.",
    ),
});

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
    self: z.url(),
  }),
  display_name: z.string(),
  jit_enabled: z.boolean().optional(),
});

export const organizationListSchema = z.object({
  api_version: z.literal("org/v2"),
  kind: z.literal("OrganizationList"),
  metadata: z
    .object({
      next: z.url().optional(),
    })
    .optional(),
  data: z.array(organizationSchema),
});

export type Organization = z.infer<typeof organizationSchema>;
export type OrganizationList = z.infer<typeof organizationListSchema>;

export class ListOrganizationsHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { pageSize, pageToken } = listOrganizationsArguments.parse(
      toolArguments ?? {},
    );

    try {
      const pathBasedClient = wrapAsPathBasedClient(
        runtime.clientManager.getConfluentCloudRestClient(),
      );

      const { data: response, error } = await pathBasedClient[
        "/org/v2/organizations"
      ].GET({
        params: {
          query: {
            page_size: pageSize,
            page_token: pageToken,
          },
        },
      });

      if (error) {
        logger.error({ error }, "API Error");
        return this.createResponse(
          `Failed to fetch organizations: ${JSON.stringify(error)}`,
          true,
          { error },
        );
      }

      try {
        const validated = organizationListSchema.parse(response);
        const organizations = validated.data.map((org) => ({
          id: org.id,
          name: org.display_name,
          resource_name: org.metadata.resource_name,
          created_at: org.metadata.created_at,
          updated_at: org.metadata.updated_at,
        }));

        const nextPageToken = validated.metadata?.next
          ? (new URL(validated.metadata.next).searchParams.get("page_token") ??
            undefined)
          : undefined;

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

        const summary = `Retrieved ${organizations.length} organization${
          organizations.length === 1 ? "" : "s"
        }${nextPageToken ? " (more pages available — pass nextPageToken back as pageToken to fetch the next page)" : ""}:`;

        return this.createResponse(`${summary}\n${orgDetails}`, false, {
          organizations,
          nextPageToken,
        });
      } catch (validationError) {
        logger.error(
          { error: validationError },
          "Organization list validation error",
        );
        const message =
          validationError instanceof Error
            ? validationError.message
            : String(validationError);
        return this.createResponse(
          `Invalid organization list data: ${message}`,
          true,
          { error: validationError },
        );
      }
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
        "List Confluent Cloud organizations the current credentials can see. Paginated; if the response includes a nextPageToken, pass it back as pageToken to fetch additional pages.",
      inputSchema: listOrganizationsArguments.shape,
      annotations: READ_ONLY,
    };
  }

  enabledConnectionIds(runtime: ServerRuntime): string[] {
    return connectionIdsWhere(runtime.config.connections, hasConfluentCloud);
  }
}
