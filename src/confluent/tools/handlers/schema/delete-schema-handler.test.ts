import { DeleteSchemaHandler } from "@src/confluent/tools/handlers/schema/delete-schema-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  getMockedRestClient,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const SR_CONN = {
  schema_registry: { endpoint: "https://sr.example.com" },
};

describe("delete-schema-handler.ts", () => {
  describe("DeleteSchemaHandler", () => {
    const handler = new DeleteSchemaHandler();

    describe("handle()", () => {
      it("should issue DELETE /subjects/{subject} when version is omitted (whole-subject delete)", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.DELETE.mockResolvedValue({
          response: { status: 200 } as Response,
          data: [1, 2, 3],
        });
        clientManager.getConfluentCloudSchemaRegistryRestClient.mockResolvedValue(
          sr,
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWith(SR_CONN, DEFAULT_CONNECTION_ID, clientManager),
          args: { subject: "my-subject" },
          outcome: { resolves: 'Successfully deleted subject "my-subject"' },
          clientManager,
        });

        expect(sr.DELETE).toHaveBeenCalledWith(
          "/subjects/{subject}",
          expect.objectContaining({
            params: expect.objectContaining({
              path: { subject: "my-subject" },
              query: { permanent: false },
            }),
          }),
        );
      });

      it("should issue DELETE /subjects/{subject}/versions/{version} when version is provided", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.DELETE.mockResolvedValue({
          response: { status: 200 } as Response,
          data: 3,
        });
        clientManager.getConfluentCloudSchemaRegistryRestClient.mockResolvedValue(
          sr,
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWith(SR_CONN, DEFAULT_CONNECTION_ID, clientManager),
          args: { subject: "my-subject", version: "3" },
          outcome: {
            resolves: 'Successfully deleted version 3 of subject "my-subject"',
          },
          clientManager,
        });

        expect(sr.DELETE).toHaveBeenCalledWith(
          "/subjects/{subject}/versions/{version}",
          expect.objectContaining({
            params: expect.objectContaining({
              path: { subject: "my-subject", version: "3" },
              query: { permanent: false },
            }),
          }),
        );
      });

      it("should pass version=latest through to the URL unchanged (REST server resolves it)", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.DELETE.mockResolvedValue({
          response: { status: 200 } as Response,
          data: 7,
        });
        clientManager.getConfluentCloudSchemaRegistryRestClient.mockResolvedValue(
          sr,
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWith(SR_CONN, DEFAULT_CONNECTION_ID, clientManager),
          args: { subject: "my-subject", version: "latest" },
          outcome: { resolves: "Successfully deleted version latest" },
          clientManager,
        });

        expect(sr.DELETE).toHaveBeenCalledWith(
          "/subjects/{subject}/versions/{version}",
          expect.objectContaining({
            params: expect.objectContaining({
              path: { subject: "my-subject", version: "latest" },
            }),
          }),
        );
      });

      it("should pass permanent=true through to the DELETE query string", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.DELETE.mockResolvedValue({
          response: { status: 200 } as Response,
          data: [1],
        });
        clientManager.getConfluentCloudSchemaRegistryRestClient.mockResolvedValue(
          sr,
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWith(SR_CONN, DEFAULT_CONNECTION_ID, clientManager),
          args: { subject: "my-subject", permanent: true },
          outcome: { resolves: 'Successfully deleted subject "my-subject"' },
          clientManager,
        });

        expect(sr.DELETE).toHaveBeenCalledWith(
          "/subjects/{subject}",
          expect.objectContaining({
            params: expect.objectContaining({
              query: { permanent: true },
            }),
          }),
        );
      });

      it("should pass environment_id through to getConfluentCloudSchemaRegistryRestClient (OAuth wiring)", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.DELETE.mockResolvedValue({
          response: { status: 200 } as Response,
          data: [1],
        });
        clientManager.getConfluentCloudSchemaRegistryRestClient.mockResolvedValue(
          sr,
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWith(SR_CONN, DEFAULT_CONNECTION_ID, clientManager),
          args: { subject: "my-subject", environment_id: "env-42" },
          outcome: { resolves: "Successfully deleted" },
          clientManager,
        });

        expect(
          clientManager.getConfluentCloudSchemaRegistryRestClient,
        ).toHaveBeenCalledWith("env-42");
      });

      it("should return an isError response when the REST DELETE returns an error payload", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.DELETE.mockResolvedValue({
          response: { status: 404 } as Response,
          error: { message: "subject not found" },
        });
        clientManager.getConfluentCloudSchemaRegistryRestClient.mockResolvedValue(
          sr,
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWith(SR_CONN, DEFAULT_CONNECTION_ID, clientManager),
          args: { subject: "missing" },
          outcome: { resolves: 'Failed to delete subject "missing"' },
          clientManager,
        });
      });
    });
  });
});
