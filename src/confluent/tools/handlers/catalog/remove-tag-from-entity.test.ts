import { RemoveTagFromEntityHandler } from "@src/confluent/tools/handlers/catalog/remove-tag-from-entity.js";
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

const VALID_ARGS = { tagName: "PII", qualifiedName: "lsrc:lkc:orders" };

// Each case runs against runtimeWithDecoy, so assertHandleCase routes to the
// real connection and asserts the decoy's client manager stays untouched.
describe("remove-tag-from-entity.ts", () => {
  describe("RemoveTagFromEntityHandler", () => {
    const handler = new RemoveTagFromEntityHandler();

    describe("handle()", () => {
      it("should resolve with a success message naming the removed tag and entity", async () => {
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
          args: VALID_ARGS,
          outcome: { resolves: "Successfully removed tag PII" },
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
          args: VALID_ARGS,
          outcome: {
            resolves: "Failed to remove tag from entity",
            isError: true,
          },
          clientManager,
        });
      });

      it("should throw a ZodError when qualifiedName is absent", async () => {
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            getMockedClientManager(),
          ),
          args: { tagName: "PII" },
          outcome: { throws: "ZodError" },
        });
      });
    });
  });
});
