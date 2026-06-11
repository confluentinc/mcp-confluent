import { DeleteTagHandler } from "@src/confluent/tools/handlers/catalog/delete-tag.js";
import {
  CATALOG_CONN,
  DEFAULT_CONNECTION_ID,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

// Each case runs against runtimeWithDecoy, so assertHandleCase routes to the
// real connection and asserts the decoy's client manager stays untouched.
describe("delete-tag.ts", () => {
  describe("DeleteTagHandler", () => {
    const handler = new DeleteTagHandler();

    describe("handle()", () => {
      it("should resolve with a success message naming the deleted tag", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudSchemaRegistryRestClient()
          .DELETE.mockResolvedValue({ response: { status: 204 } });
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
        clientManager
          .getConfluentCloudSchemaRegistryRestClient()
          .DELETE.mockResolvedValue({ error: { message: "boom" } });
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
    });
  });
});
