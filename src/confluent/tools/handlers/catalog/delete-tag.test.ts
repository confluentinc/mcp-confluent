import { DeleteTagHandler } from "@src/confluent/tools/handlers/catalog/delete-tag.js";
import {
  CATALOG_CONN,
  DEFAULT_CONNECTION_ID,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  getMockedRestClient,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

// Each case runs against runtimeWithDecoy, so assertHandleCase routes to the
// real connection and asserts the decoy's client manager stays untouched.
describe("delete-tag.ts", () => {
  describe("DeleteTagHandler", () => {
    const handler = new DeleteTagHandler();

    describe("handle()", () => {
      it("should resolve with a success message naming the deleted tag", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.DELETE.mockResolvedValue({ response: { status: 204 } });
        clientManager.getSchemaRegistryRestClient.mockResolvedValue(sr);
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { tagName: "PII" },
          outcome: { resolves: "Successfully deleted tag: PII" },
          clientManager,
        });
      });

      it("should resolve with an error response when the API returns an error", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.DELETE.mockResolvedValue({ error: { message: "boom" } });
        clientManager.getSchemaRegistryRestClient.mockResolvedValue(sr);
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { tagName: "PII" },
          outcome: { resolves: "Failed to delete tag", isError: true },
          clientManager,
        });
      });

      it("should throw a ZodError when tagName is absent", async () => {
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            getMockedClientManager(),
          ),
          args: {},
          outcome: { throws: "ZodError" },
        });
      });

      it("should pass environment_id through to getSchemaRegistryRestClient (OAuth wiring)", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.DELETE.mockResolvedValue({ response: { status: 204 } });
        clientManager.getSchemaRegistryRestClient.mockResolvedValue(sr);
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { tagName: "PII", environment_id: "env-42" },
          outcome: { resolves: "Successfully deleted tag: PII" },
          clientManager,
        });

        expect(clientManager.getSchemaRegistryRestClient).toHaveBeenCalledWith(
          "env-42",
        );
      });
    });
  });
});
