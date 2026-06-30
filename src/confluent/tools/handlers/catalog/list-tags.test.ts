import { ListTagsHandler } from "@src/confluent/tools/handlers/catalog/list-tags.js";
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
describe("list-tags.ts", () => {
  describe("ListTagsHandler", () => {
    const handler = new ListTagsHandler();

    describe("handle()", () => {
      it("should resolve with the tag definitions on success", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.GET.mockResolvedValue({ data: [{ name: "PII" }] });
        clientManager.getSchemaRegistryRestClient.mockResolvedValue(sr);
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: { resolves: "Successfully retrieved tags" },
          clientManager,
        });
      });

      it("should resolve with an error response when the API returns an error", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.GET.mockResolvedValue({ error: { message: "boom" } });
        clientManager.getSchemaRegistryRestClient.mockResolvedValue(sr);
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: { resolves: "Failed to list tags", isError: true },
          clientManager,
        });
      });

      it("should pass environment_id through to getSchemaRegistryRestClient (OAuth wiring)", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.GET.mockResolvedValue({ data: [] });
        clientManager.getSchemaRegistryRestClient.mockResolvedValue(sr);
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { environment_id: "env-42" },
          outcome: { resolves: "Successfully retrieved tags" },
          clientManager,
        });

        expect(clientManager.getSchemaRegistryRestClient).toHaveBeenCalledWith(
          "env-42",
        );
      });
    });
  });
});
