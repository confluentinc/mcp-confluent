import type { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import type { CallToolResult } from "@src/confluent/schema.js";
import type { ToolConfig } from "@src/confluent/tools/base-tools.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolCategory,
} from "@src/confluent/tools/base-tools.js";
import { hasSchemaRegistryOrOAuth } from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { logger } from "@src/logger.js";
import type { ServerRuntime } from "@src/server-runtime.js";
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
  environment_id: z
    .string()
    .optional()
    .describe(
      "Confluent Cloud environment ID (env-...) that owns the Schema Registry. Discover via list-environments.",
    ),
});

export class ListSchemasHandler extends BaseToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const { clientManager } = this.resolveConnection(runtime, toolArguments);
    const { latestOnly, subjectPrefix, deleted, environment_id } =
      listSchemasArguments.parse(toolArguments);

    logger.debug(
      {
        latestOnly,
        subjectPrefix,
        deleted,
        environment_id,
      },
      "ListSchemasHandler.handle called with arguments",
    );

    const registry: SchemaRegistryClient =
      await clientManager.getSchemaRegistrySdkClient(environment_id);

    try {
      const subjects = await fetchSubjects(registry, subjectPrefix);
      const result: Record<string, unknown> = {};
      for (const subject of subjects) {
        result[subject] = latestOnly
          ? await fetchLatestSchema(registry, subject)
          : await fetchAllVersions(registry, subject, deleted);
      }
      logger.info(
        { subjects: Object.keys(result).length },
        "Returning schema listing result",
      );
      return this.createResponse(JSON.stringify(result));
    } catch (error) {
      const message = describeError(error);
      logger.error({ err: error, message }, "Failed to list schemas");
      return this.createResponse(`Failed to list schemas: ${message}`, true);
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_SCHEMAS,
      description: "List all schemas in the Schema Registry.",
      inputSchema: listSchemasArguments.shape,
      annotations: READ_ONLY,
    };
  }
  readonly category = ToolCategory.SchemaRegistry;
  readonly predicate = hasSchemaRegistryOrOAuth;
}

/**
 * Narrow an unknown thrown value to a message, tolerating the SR SDK's habit of
 * rejecting with non-Error values: a string passes through verbatim, an Error
 * yields its message, and any other value is JSON-serialized so objects keep
 * their detail instead of collapsing to "[object Object]". String() is the last
 * resort for the two cases JSON.stringify won't hand back a string: values it
 * throws on (circular references, BigInt) and values it returns `undefined` for
 * without throwing (bare undefined, functions, symbols). Either way the return
 * is always a string.
 */
function describeError(err: unknown): string {
  if (typeof err === "string") {
    return err;
  }
  if (err instanceof Error) {
    return err.message;
  }
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/**
 * Fetch every subject from the registry, narrowed to an optional prefix.
 * Prefix matching is client-side because the SR list endpoint takes no prefix.
 */
async function fetchSubjects(
  registry: SchemaRegistryClient,
  subjectPrefix: string | undefined,
): Promise<string[]> {
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
  return subjects;
}

/**
 * Resolve one subject's latest schema metadata, degrading to an `{ error }`
 * placeholder so a single bad subject doesn't abort the whole listing.
 */
async function fetchLatestSchema(
  registry: SchemaRegistryClient,
  subject: string,
): Promise<unknown> {
  try {
    const latest = await registry.getLatestSchemaMetadata(subject);
    logger.debug({ subject, latest }, "Fetched latest schema metadata");
    return {
      version: latest.version,
      id: latest.id,
      schemaType: latest.schemaType,
      schema: latest.schema,
    };
  } catch (err) {
    logger.warn(
      { subject, err, message: describeError(err) },
      "Failed to fetch latest schema metadata",
    );
    return { error: describeError(err) };
  }
}

/**
 * Resolve every version of one subject in parallel, degrading to an `{ error }`
 * placeholder for the whole subject if its version list can't be fetched.
 */
async function fetchAllVersions(
  registry: SchemaRegistryClient,
  subject: string,
  deleted: boolean | undefined,
): Promise<unknown> {
  let versions: number[];
  try {
    versions = await registry.getAllVersions(subject);
  } catch (err) {
    logger.warn(
      { subject, err, message: describeError(err) },
      "Failed to fetch all versions for subject",
    );
    return { error: describeError(err) };
  }
  logger.debug({ subject, versions }, "Fetched all schema versions");
  return Promise.all(
    versions.map((version) =>
      fetchVersion(registry, subject, version, deleted),
    ),
  );
}

/**
 * Resolve one (subject, version) pair, degrading to a `{ version, error }`
 * entry so one hard-deleted or missing version doesn't drop its siblings.
 */
async function fetchVersion(
  registry: SchemaRegistryClient,
  subject: string,
  version: number,
  deleted: boolean | undefined,
): Promise<unknown> {
  try {
    const schema = await registry.getSchemaMetadata(subject, version, deleted);
    logger.debug(
      { subject, version, schema },
      "Fetched schema metadata for version",
    );
    return {
      version: schema.version,
      id: schema.id,
      schemaType: schema.schemaType,
      schema: schema.schema,
    };
  } catch (err) {
    logger.warn(
      { subject, version, err, message: describeError(err) },
      "Failed to fetch schema metadata for version",
    );
    return { version, error: describeError(err) };
  }
}
