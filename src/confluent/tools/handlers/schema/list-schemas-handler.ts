import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import { logger } from "@src/logger.js";
import { z } from "zod";

const listSchemasArguments = z.object({
  latestOnly: z
    .boolean()
    .describe("If true, only return the latest version of each schema.")
    .default(true)
    .optional(),
  subjectPrefix: z
    .string()
    .describe("The prefix of the subject to list schemas for.")
    .optional(),
  deleted: z
    .boolean()
    .describe("List deleted schemas. (Only used if latestOnly is false)")
    .default(false)
    .optional(),
});

export class ListSchemasHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { latestOnly, subjectPrefix, deleted } =
      listSchemasArguments.parse(toolArguments);

    logger.debug(
      {
        latestOnly,
        subjectPrefix,
        deleted,
      },
      "ListSchemasHandler.handle called with arguments",
    );

    const registry: SchemaRegistryClient =
      clientManager.getSchemaRegistryClient();

    try {
      let subjects: string[] = await registry.getAllSubjects();
      logger.debug(
        { subjectsCount: subjects.length },
        "Fetched all subjects from registry",
      );
      if (subjectPrefix) {
        subjects = subjects.filter((s) => s.startsWith(subjectPrefix));
        logger.debug(
          { filteredSubjectsCount: subjects.length, subjectPrefix },
          "Filtered subjects by prefix",
        );
      }

      const result: Record<string, unknown> = {};
      for (const subject of subjects) {
        if (latestOnly) {
          try {
            const latest = await registry.getLatestSchemaMetadata(subject);
            logger.debug({ subject, latest }, "Fetched latest schema metadata");
            result[subject] = {
              version: latest.version,
              id: latest.id,
              schemaType: latest.schemaType,
              schema: latest.schema,
            };
          } catch (err) {
            logger.warn(
              {
                subject,
                error: err instanceof Error ? err.message : String(err),
              },
              "Failed to fetch latest schema metadata",
            );
            result[subject] = {
              error: err instanceof Error ? err.message : String(err),
            };
          }
        } else {
          try {
            const versions: number[] = await registry.getAllVersions(subject);
            logger.debug({ subject, versions }, "Fetched all schema versions");
            result[subject] = [];
            for (const version of versions) {
              try {
                const schema = await registry.getSchemaMetadata(
                  subject,
                  version,
                  deleted,
                );
                logger.debug(
                  { subject, version, schema },
                  "Fetched schema metadata for version",
                );
                (result[subject] as unknown[]).push({
                  version: schema.version,
                  id: schema.id,
                  schemaType: schema.schemaType,
                  schema: schema.schema,
                });
              } catch (err) {
                logger.warn(
                  {
                    subject,
                    version,
                    error: err instanceof Error ? err.message : String(err),
                  },
                  "Failed to fetch schema metadata for version",
                );
                (result[subject] as unknown[]).push({
                  version,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
          } catch (err) {
            logger.warn(
              {
                subject,
                error: err instanceof Error ? err.message : String(err),
              },
              "Failed to fetch all versions for subject",
            );
            result[subject] = {
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }
      }
      logger.info(
        { subjects: Object.keys(result).length },
        "Returning schema listing result",
      );
      return this.createResponse(JSON.stringify(result));
    } catch (error) {
      logger.error(
        {
          error: error instanceof Error ? error.message : JSON.stringify(error),
        },
        "Failed to list schemas",
      );
      return this.createResponse(
        `Failed to list schemas: ${error instanceof Error ? error.message : JSON.stringify(error)}`,
        true,
      );
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_SCHEMAS,
      description: "List all schemas in the Schema Registry.",
      inputSchema: listSchemasArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return [
      "SCHEMA_REGISTRY_ENDPOINT",
      "SCHEMA_REGISTRY_API_KEY",
      "SCHEMA_REGISTRY_API_SECRET",
    ];
  }
}
