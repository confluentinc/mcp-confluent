import { SearchTopicsByNameHandler } from "@src/confluent/tools/handlers/search/search-topics-by-name-handler.js";
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
describe("search-topics-by-name-handler.ts", () => {
  describe("SearchTopicsByNameHandler", () => {
    const handler = new SearchTopicsByNameHandler();

    describe("handle()", () => {
      it("should resolve with matching qualified names on success", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.GET.mockResolvedValue({
          data: {
            entities: [{ attributes: { qualifiedName: "lsrc:lkc:orders" } }],
          },
        });
        clientManager.getSchemaRegistryRestClient.mockResolvedValue(sr);
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { topicName: "orders" },
          outcome: { resolves: "lsrc:lkc:orders" },
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
          args: { topicName: "orders" },
          outcome: {
            resolves: "Failed to search for topics by name",
            isError: true,
          },
          clientManager,
        });
      });

      it("should throw a ZodError when topicName is absent", async () => {
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
        sr.GET.mockResolvedValue({
          data: {
            entities: [{ attributes: { qualifiedName: "lsrc:lkc:orders" } }],
          },
        });
        clientManager.getSchemaRegistryRestClient.mockResolvedValue(sr);
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { topicName: "orders", environment_id: "env-42" },
          outcome: { resolves: "lsrc:lkc:orders" },
          clientManager,
        });

        expect(clientManager.getSchemaRegistryRestClient).toHaveBeenCalledWith(
          "env-42",
        );
      });
    });
  });
});
