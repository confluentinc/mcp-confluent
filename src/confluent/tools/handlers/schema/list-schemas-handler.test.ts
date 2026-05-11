import { ListSchemasHandler } from "@src/confluent/tools/handlers/schema/list-schemas-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const SR_CONN = {
  schema_registry: { endpoint: "https://sr.example.com" },
};

describe("list-schemas-handler.ts", () => {
  describe("ListSchemasHandler", () => {
    const handler = new ListSchemasHandler();

    describe("handle()", () => {
      it("should return a JSON map of subject -> latest schema metadata when latestOnly is true (the default)", async () => {
        const clientManager = getMockedClientManager();
        const sr = clientManager.getSchemaRegistryClient();
        sr.getAllSubjects.mockResolvedValue(["subject-a", "subject-b"]);
        sr.getLatestSchemaMetadata.mockImplementation(
          async (subject: string) => ({
            version: 1,
            id: subject === "subject-a" ? 10 : 20,
            schemaType: "AVRO",
            schema: `{"name":"${subject}"}`,
          }),
        );
        clientManager.getSchemaRegistrySdkClient.mockResolvedValue(sr);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(SR_CONN, DEFAULT_CONNECTION_ID, clientManager),
          args: {},
          outcome: { resolves: '"subject-a":{"version":1,"id":10' },
          clientManager,
        });

        expect(sr.getAllSubjects).toHaveBeenCalledOnce();
        expect(sr.getLatestSchemaMetadata).toHaveBeenCalledWith("subject-a");
        expect(sr.getLatestSchemaMetadata).toHaveBeenCalledWith("subject-b");
      });

      it("should filter subjects to those matching subjectPrefix before fetching metadata", async () => {
        const clientManager = getMockedClientManager();
        const sr = clientManager.getSchemaRegistryClient();
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
        clientManager.getSchemaRegistrySdkClient.mockResolvedValue(sr);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(SR_CONN, DEFAULT_CONNECTION_ID, clientManager),
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
        const clientManager = getMockedClientManager();
        const sr = clientManager.getSchemaRegistryClient();
        sr.getAllSubjects.mockResolvedValue([]);
        clientManager.getSchemaRegistrySdkClient.mockResolvedValue(sr);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(SR_CONN, DEFAULT_CONNECTION_ID, clientManager),
          args: { environment_id: "env-42" },
          outcome: { resolves: "{}" },
          clientManager,
        });

        expect(clientManager.getSchemaRegistrySdkClient).toHaveBeenCalledWith(
          "env-42",
        );
      });

      it("should return an isError response when getAllSubjects rejects", async () => {
        const clientManager = getMockedClientManager();
        const sr = clientManager.getSchemaRegistryClient();
        sr.getAllSubjects.mockRejectedValue(new Error("registry unreachable"));
        clientManager.getSchemaRegistrySdkClient.mockResolvedValue(sr);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(SR_CONN, DEFAULT_CONNECTION_ID, clientManager),
          args: {},
          outcome: {
            resolves: "Failed to list schemas: registry unreachable",
          },
          clientManager,
        });
      });
    });
  });
});
