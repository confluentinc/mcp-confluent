import { AddTagToTopicHandler } from "@src/confluent/tools/handlers/catalog/add-tags-to-topic.js";
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

const VALID_ARGS = {
  tagAssignments: [{ entityName: "lsrc:lkc:orders", typeName: "PII" }],
};

// Each case runs against runtimeWithDecoy, so assertHandleCase routes to the
// real connection and asserts the decoy's client manager stays untouched.
describe("add-tags-to-topic.ts", () => {
  describe("AddTagToTopicHandler", () => {
    const handler = new AddTagToTopicHandler();

    describe("handle()", () => {
      it("should resolve with a success message when the tag is assigned", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudSchemaRegistryRestClient()
          .POST.mockResolvedValue({
            data: [{ entityName: "lsrc:lkc:orders" }],
          });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: VALID_ARGS,
          outcome: { resolves: "Successfully assigned tag" },
          clientManager,
        });
      });

      it("should resolve with an error response when the API returns an error", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudSchemaRegistryRestClient()
          .POST.mockResolvedValue({ error: { message: "boom" } });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: VALID_ARGS,
          outcome: { resolves: "Failed to assign tag", isError: true },
          clientManager,
        });
      });

      it("should throw a ZodError when tagAssignments is absent", async () => {
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
