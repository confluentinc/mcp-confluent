import type { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { CREATE_UPDATE } from "@src/confluent/tools/base-tools.js";
import { CreateSchemaHandler } from "@src/confluent/tools/handlers/schema/create-schema-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
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

const AVRO_SCHEMA = '{"type":"record","name":"Foo","fields":[]}';

describe("create-schema-handler.ts", () => {
  describe("CreateSchemaHandler", () => {
    const handler = new CreateSchemaHandler();

    describe("getToolConfig()", () => {
      it("should expose the create-schema tool with CREATE_UPDATE annotations", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.CREATE_SCHEMA);
        expect(config.annotations).toBe(CREATE_UPDATE);
        expect(config.inputSchema).toHaveProperty("subject");
        expect(config.inputSchema).toHaveProperty("schema");
        expect(config.inputSchema).toHaveProperty("schemaType");
      });
    });

    describe("handle()", () => {
      let clientManager: MockedClientManager;
      let sr: Mocked<SchemaRegistryClient>;

      beforeEach(() => {
        clientManager = getMockedClientManager();
        sr = clientManager.getSchemaRegistryClient();
      });

      it("should register the schema and report the assigned id and version", async () => {
        sr.registerFullResponse.mockResolvedValue({
          id: 42,
          version: 1,
          guid: "abc-guid",
          subject: "my-subject",
          schema: AVRO_SCHEMA,
          schemaType: "AVRO",
        });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            subject: "my-subject",
            schema: AVRO_SCHEMA,
            schemaType: "AVRO",
          },
          outcome: {
            resolves:
              'Successfully registered schema for subject "my-subject". Schema ID: 42, version: 1, GUID: abc-guid.',
          },
          clientManager,
        });

        expect(sr.registerFullResponse).toHaveBeenCalledWith(
          "my-subject",
          { schema: AVRO_SCHEMA, schemaType: "AVRO", references: undefined },
          false,
        );
      });

      it("should pass references and normalize through to registerFullResponse", async () => {
        sr.registerFullResponse.mockResolvedValue({
          id: 7,
          version: 2,
          guid: "refs-guid",
          subject: "with-refs",
          schema: AVRO_SCHEMA,
          schemaType: "AVRO",
        });
        const references = [
          { name: "com.acme.Bar", subject: "bar-value", version: 3 },
        ];

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            subject: "with-refs",
            schema: AVRO_SCHEMA,
            schemaType: "AVRO",
            references,
            normalize: true,
          },
          outcome: { resolves: "Schema ID: 7, version: 2" },
          clientManager,
        });

        expect(sr.registerFullResponse).toHaveBeenCalledWith(
          "with-refs",
          { schema: AVRO_SCHEMA, schemaType: "AVRO", references },
          true,
        );
      });

      it("should pass a PROTOBUF schemaType through unchanged", async () => {
        sr.registerFullResponse.mockResolvedValue({
          id: 9,
          version: 1,
          guid: "proto-guid",
          subject: "proto-subject",
          schema: 'syntax = "proto3";',
          schemaType: "PROTOBUF",
        });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            subject: "proto-subject",
            schema: 'syntax = "proto3";',
            schemaType: "PROTOBUF",
          },
          outcome: { resolves: "Schema ID: 9" },
          clientManager,
        });

        expect(sr.registerFullResponse).toHaveBeenCalledWith(
          "proto-subject",
          {
            schema: 'syntax = "proto3";',
            schemaType: "PROTOBUF",
            references: undefined,
          },
          false,
        );
      });

      it("should thread environment_id through to getSchemaRegistrySdkClient (OAuth wiring)", async () => {
        sr.registerFullResponse.mockResolvedValue({
          id: 1,
          version: 1,
          guid: "env-guid",
          subject: "env-subject",
          schema: AVRO_SCHEMA,
          schemaType: "AVRO",
        });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            subject: "env-subject",
            schema: AVRO_SCHEMA,
            schemaType: "AVRO",
            environment_id: "env-42",
          },
          outcome: { resolves: "Schema ID: 1" },
          clientManager,
        });

        expect(clientManager.getSchemaRegistrySdkClient).toHaveBeenCalledWith(
          "env-42",
        );
      });

      it("should return an isError response when registration fails", async () => {
        sr.registerFullResponse.mockRejectedValue(
          new Error("incompatible schema"),
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            SR_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            subject: "bad-subject",
            schema: AVRO_SCHEMA,
            schemaType: "AVRO",
          },
          outcome: {
            resolves:
              'Failed to register schema for subject "bad-subject": incompatible schema',
            isError: true,
          },
          clientManager,
        });
      });

      it.each([
        {
          name: "subject is missing",
          args: { schema: AVRO_SCHEMA, schemaType: "AVRO" },
          path: ["subject"],
        },
        {
          name: "schema is missing",
          args: { subject: "s", schemaType: "AVRO" },
          path: ["schema"],
        },
        {
          name: "schemaType is missing",
          args: { subject: "s", schema: AVRO_SCHEMA },
          path: ["schemaType"],
        },
        {
          name: "schemaType is not a valid enum value",
          args: { subject: "s", schema: AVRO_SCHEMA, schemaType: "XML" },
          path: ["schemaType"],
        },
      ])(
        "should reject with a ZodError at $path when $name",
        async ({ args, path }) => {
          await expect(
            handler.handle(
              runtimeWith(SR_CONN, DEFAULT_CONNECTION_ID, clientManager),
              args,
            ),
          ).rejects.toMatchObject({
            issues: expect.arrayContaining([expect.objectContaining({ path })]),
          });
          expect(sr.registerFullResponse).not.toHaveBeenCalled();
        },
      );
    });
  });
});
