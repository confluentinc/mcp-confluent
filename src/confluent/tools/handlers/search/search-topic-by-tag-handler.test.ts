import { SearchTopicsByTagHandler } from "@src/confluent/tools/handlers/search/search-topic-by-tag-handler.js";
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
describe("search-topic-by-tag-handler.ts", () => {
  describe("SearchTopicsByTagHandler", () => {
    const handler = new SearchTopicsByTagHandler();

    describe("handle()", () => {
      it("should resolve with the serialized search response on success", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudSchemaRegistryRestClient()
          .GET.mockResolvedValue({
            data: {
              entities: [{ attributes: { qualifiedName: "lsrc:lkc:orders" } }],
            },
          });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { topicTag: "PII" },
          outcome: { resolves: "lsrc:lkc:orders" },
          clientManager,
        });
      });

      it("should resolve with an error response when the API returns an error", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudSchemaRegistryRestClient()
          .GET.mockResolvedValue({ error: { message: "boom" } });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { topicTag: "PII" },
          outcome: {
            resolves: "Failed to search for topics by tag",
            isError: true,
          },
          clientManager,
        });
      });
    });
  });
});
