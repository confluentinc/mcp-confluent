import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { ListSchemasHandler } from "@src/confluent/tools/handlers/schema/list-schemas-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { textOf } from "@tests/call-tool-result.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  type MockedClientManager,
} from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it, type Mocked } from "vitest";

const SR_CONN = {
  schema_registry: { endpoint: "https://sr.example.com" },
};

describe("list-schemas-handler.ts", () => {
  describe("ListSchemasHandler", () => {
    const handler = new ListSchemasHandler();

    describe("handle()", () => {
      let clientManager: MockedClientManager;
      let sr: Mocked<SchemaRegistryClient>;

      beforeEach(() => {
        clientManager = getMockedClientManager();
        sr = clientManager.getSchemaRegistryClient();
      });

      it("should return a JSON map of subject -> latest schema metadata when latestOnly is true (the default)", async () => {
        sr.getAllSubjects.mockResolvedValue(["subject-a", "subject-b"]);
        sr.getLatestSchemaMetadata.mockImplementation(
          async (subject: string) => ({
            version: 1,
            id: subject === "subject-a" ? 10 : 20,
            schemaType: "AVRO",
            schema: `{"name":"${subject}"}`,
          }),
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: { resolves: '"subject-a":{"version":1,"id":10' },
          clientManager,
        });

        expect(sr.getAllSubjects).toHaveBeenCalledOnce();
        expect(sr.getLatestSchemaMetadata).toHaveBeenCalledWith("subject-a");
        expect(sr.getLatestSchemaMetadata).toHaveBeenCalledWith("subject-b");
      });

      it("should filter subjects to those matching subjectPrefix before fetching metadata", async () => {
        sr.getAllSubjects.mockResolvedValue([
          "order-events",
          "order-status",
          "user-events",
        ]);
        sr.getLatestSchemaMetadata.mockResolvedValue({
          version: 1,
          id: 1,
          schemaType: "AVRO",
          schema: "{}",
        });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { subjectPrefix: "order-" },
          outcome: { resolves: '"order-events"' },
          clientManager,
        });

        expect(sr.getLatestSchemaMetadata).toHaveBeenCalledWith("order-events");
        expect(sr.getLatestSchemaMetadata).toHaveBeenCalledWith("order-status");
        expect(sr.getLatestSchemaMetadata).not.toHaveBeenCalledWith(
          "user-events",
        );
      });

      it("should pass environment_id through to getSchemaRegistrySdkClient (OAuth wiring)", async () => {
        sr.getAllSubjects.mockResolvedValue([]);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { environment_id: "env-42" },
          outcome: { resolves: "{}" },
          clientManager,
        });

        expect(clientManager.getSchemaRegistrySdkClient).toHaveBeenCalledWith(
          "env-42",
        );
      });

      it("should return an isError response when getAllSubjects rejects", async () => {
        sr.getAllSubjects.mockRejectedValue(new Error("registry unreachable"));

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: {
            resolves: "Failed to list schemas: registry unreachable",
            isError: true,
          },
          clientManager,
        });
      });

      it("should record a per-subject error entry (not fail the whole call) when getLatestSchemaMetadata rejects for one subject", async () => {
        sr.getAllSubjects.mockResolvedValue(["healthy", "broken"]);
        sr.getLatestSchemaMetadata.mockImplementation(
          async (subject: string) => {
            if (subject === "broken") {
              throw new Error("subject broken has no schema");
            }
            return {
              version: 3,
              id: 7,
              schemaType: "AVRO",
              schema: '{"name":"healthy"}',
            };
          },
        );

        const result = await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: { resolves: '"broken":{"error":', isError: false },
          clientManager,
        });

        expect(JSON.parse(textOf(result!))).toEqual({
          healthy: {
            version: 3,
            id: 7,
            schemaType: "AVRO",
            schema: '{"name":"healthy"}',
          },
          broken: { error: "subject broken has no schema" },
        });
      });

      it("should return an array of every version per subject when latestOnly is false", async () => {
        sr.getAllSubjects.mockResolvedValue(["orders"]);
        sr.getAllVersions.mockResolvedValue([1, 2]);
        sr.getSchemaMetadata.mockImplementation(
          async (subject: string, version: number) => ({
            version,
            id: 100 + version,
            schemaType: "AVRO",
            schema: `{"v":${version}}`,
          }),
        );

        const result = await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { latestOnly: false },
          outcome: { resolves: '"orders":[', isError: false },
          clientManager,
        });

        expect(sr.getLatestSchemaMetadata).not.toHaveBeenCalled();
        expect(sr.getAllVersions).toHaveBeenCalledWith("orders");
        // deleted defaults to false when the arg is omitted
        expect(sr.getSchemaMetadata).toHaveBeenCalledWith("orders", 1, false);
        expect(sr.getSchemaMetadata).toHaveBeenCalledWith("orders", 2, false);

        // versions are fetched via Promise.all, so push order is not guaranteed
        const parsed = JSON.parse(textOf(result!)) as Record<string, unknown[]>;
        expect(parsed.orders).toEqual(
          expect.arrayContaining([
            { version: 1, id: 101, schemaType: "AVRO", schema: '{"v":1}' },
            { version: 2, id: 102, schemaType: "AVRO", schema: '{"v":2}' },
          ]),
        );
        expect(parsed.orders).toHaveLength(2);
      });

      it("should forward deleted=true to getSchemaMetadata when latestOnly is false", async () => {
        sr.getAllSubjects.mockResolvedValue(["orders"]);
        sr.getAllVersions.mockResolvedValue([5]);
        sr.getSchemaMetadata.mockResolvedValue({
          version: 5,
          id: 50,
          schemaType: "AVRO",
          schema: "{}",
        });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { latestOnly: false, deleted: true },
          outcome: { resolves: '"orders":[', isError: false },
          clientManager,
        });

        expect(sr.getSchemaMetadata).toHaveBeenCalledWith("orders", 5, true);
      });

      it("should record a per-version error entry when getSchemaMetadata rejects for one version (latestOnly false)", async () => {
        sr.getAllSubjects.mockResolvedValue(["orders"]);
        sr.getAllVersions.mockResolvedValue([1, 2]);
        sr.getSchemaMetadata.mockImplementation(
          async (subject: string, version: number) => {
            if (version === 2) {
              throw new Error("version 2 was hard-deleted");
            }
            return {
              version,
              id: 100 + version,
              schemaType: "AVRO",
              schema: `{"v":${version}}`,
            };
          },
        );

        const result = await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { latestOnly: false },
          outcome: { resolves: "version 2 was hard-deleted", isError: false },
          clientManager,
        });

        const parsed = JSON.parse(textOf(result!)) as Record<string, unknown[]>;
        expect(parsed.orders).toEqual(
          expect.arrayContaining([
            { version: 1, id: 101, schemaType: "AVRO", schema: '{"v":1}' },
            { version: 2, error: "version 2 was hard-deleted" },
          ]),
        );
        expect(parsed.orders).toHaveLength(2);
      });

      it("should record a per-subject error entry when getAllVersions rejects (latestOnly false)", async () => {
        sr.getAllSubjects.mockResolvedValue(["orders"]);
        sr.getAllVersions.mockRejectedValue(
          new Error("subject orders not found"),
        );

        const result = await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { latestOnly: false },
          outcome: { resolves: '"orders":{"error":', isError: false },
          clientManager,
        });

        expect(sr.getSchemaMetadata).not.toHaveBeenCalled();
        expect(JSON.parse(textOf(result!))).toEqual({
          orders: { error: "subject orders not found" },
        });
      });

      // The handler narrows every rejection with `err instanceof Error ? err.message : ...`.
      // The SR SDK can reject with a non-Error value, so the four cases below pin the
      // fallback arm of each catch block (String(err) inside the loops, JSON.stringify at
      // the top level) rather than letting it rot as untested defensive code.

      it("should JSON.stringify a non-Error rejection from getAllSubjects in the top-level catch", async () => {
        sr.getAllSubjects.mockRejectedValue({ code: 503 });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: {
            resolves: 'Failed to list schemas: {"code":503}',
            isError: true,
          },
          clientManager,
        });
      });

      it("should String()-coerce a non-Error rejection from getLatestSchemaMetadata into the per-subject error entry", async () => {
        sr.getAllSubjects.mockResolvedValue(["orders"]);
        sr.getLatestSchemaMetadata.mockRejectedValue("registry exploded");

        const result = await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: { resolves: '"orders":{"error":', isError: false },
          clientManager,
        });

        expect(JSON.parse(textOf(result!))).toEqual({
          orders: { error: "registry exploded" },
        });
      });

      it("should String()-coerce a non-Error rejection from getSchemaMetadata into the per-version error entry", async () => {
        sr.getAllSubjects.mockResolvedValue(["orders"]);
        sr.getAllVersions.mockResolvedValue([1]);
        sr.getSchemaMetadata.mockRejectedValue("version exploded");

        const result = await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { latestOnly: false },
          outcome: { resolves: "version exploded", isError: false },
          clientManager,
        });

        expect(JSON.parse(textOf(result!))).toEqual({
          orders: [{ version: 1, error: "version exploded" }],
        });
      });

      it("should String()-coerce a non-Error rejection from getAllVersions into the per-subject error entry", async () => {
        sr.getAllSubjects.mockResolvedValue(["orders"]);
        sr.getAllVersions.mockRejectedValue("versions exploded");

        const result = await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { latestOnly: false },
          outcome: { resolves: '"orders":{"error":', isError: false },
          clientManager,
        });

        expect(JSON.parse(textOf(result!))).toEqual({
          orders: { error: "versions exploded" },
        });
      });
    });

    describe("getToolConfig()", () => {
      it("should expose the expected name, READ_ONLY annotations, and input schema fields", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.LIST_SCHEMAS);
        expect(config.annotations).toBe(READ_ONLY);
        expect(
          Object.keys(config.inputSchema).sort((a, b) => a.localeCompare(b)),
        ).toEqual(["deleted", "environment_id", "latestOnly", "subjectPrefix"]);
      });
    });
  });
});
