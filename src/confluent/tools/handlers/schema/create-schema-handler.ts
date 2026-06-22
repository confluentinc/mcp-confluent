import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  CREATE_UPDATE,
  ToolCategory,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { hasSchemaRegistryOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { z } from "zod";

const createSchemaArguments = z.object({
  subject: z
    .string()
    .describe("Name of the subject to register the schema under.")
    .nonempty(),
  schema: z
    .string()
    .describe("The schema definition to register (the schema string itself).")
    .nonempty(),
  schemaType: z
    .enum(["AVRO", "JSON", "PROTOBUF"])
    .describe("The schema format. One of AVRO, JSON, or PROTOBUF."),
  references: z
    .array(
      z.object({
        name: z
          .string()
          .describe(
            "The reference name as used within this schema (e.g. the fully-qualified type name).",
          ),
        subject: z.string().describe("The subject of the referenced schema."),
        version: z
          .number()
          .int()
          .describe("The version of the referenced schema to bind to."),
      }),
    )
    .describe("Other registered schemas this schema references.")
    .optional(),
  normalize: z
    .boolean()
    .describe(
      "Whether to normalize the schema before registering. Default is false.",
    )
    .default(false)
    .optional(),
  environment_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the Schema Registry. Discover via list-environments.",
    ),
});

export class CreateSchemaHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { clientManager } = this.resolveConnection(runtime, toolArguments);
    const {
      subject,
      schema,
      schemaType,
      references,
      normalize,
      environment_id,
    } = createSchemaArguments.parse(toolArguments);

    logger.debug(
      { subject, schemaType, references, normalize, environment_id },
      "CreateSchemaHandler.handle called with arguments",
    );

    const registry: SchemaRegistryClient =
      await clientManager.getSchemaRegistrySdkClient(environment_id);

    try {
      const metadata = await registry.registerFullResponse(
        subject,
        { schema, schemaType, references },
        normalize,
      );
      logger.info(
        {
          subject,
          id: metadata.id,
          version: metadata.version,
          guid: metadata.guid,
        },
        "Successfully registered schema",
      );
      return this.createResponse(
        `Successfully registered schema for subject "${subject}". Schema ID: ${metadata.id}, version: ${metadata.version}, GUID: ${metadata.guid}.`,
      );
    } catch (error) {
      logger.error(
        {
          subject,
          error: error instanceof Error ? error.message : JSON.stringify(error),
        },
        "Failed to register schema",
      );
      return this.createResponse(
        `Failed to register schema for subject "${subject}": ${error instanceof Error ? error.message : JSON.stringify(error)}`,
        true,
      );
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.CREATE_SCHEMA,
      description:
        "Register a new schema (or a new version of an existing schema) under a subject in the Schema Registry.",
      inputSchema: createSchemaArguments.shape,
      annotations: CREATE_UPDATE,
    };
  }
  readonly category = ToolCategory.SchemaRegistry;
  readonly predicate = hasSchemaRegistryOrOAuth;
}
