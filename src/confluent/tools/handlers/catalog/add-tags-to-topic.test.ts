import { AddTagToTopicHandler } from "@src/confluent/tools/handlers/catalog/add-tags-to-topic.js";
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
        const sr = getMockedRestClient();
        sr.POST.mockResolvedValue({
          data: [{ entityName: "lsrc:lkc:orders" }],
        });
        clientManager.getSchemaRegistryRestClient.mockResolvedValue(sr);
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
        const sr = getMockedRestClient();
        sr.POST.mockResolvedValue({ error: { message: "boom" } });
        clientManager.getSchemaRegistryRestClient.mockResolvedValue(sr);
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

      it("should pass environment_id through to getSchemaRegistryRestClient (OAuth wiring)", async () => {
        const clientManager = getMockedClientManager();
        const sr = getMockedRestClient();
        sr.POST.mockResolvedValue({
          data: [{ entityName: "lsrc:lkc:orders" }],
        });
        clientManager.getSchemaRegistryRestClient.mockResolvedValue(sr);
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { ...VALID_ARGS, environment_id: "env-42" },
          outcome: { resolves: "Successfully assigned tag" },
          clientManager,
        });

        expect(clientManager.getSchemaRegistryRestClient).toHaveBeenCalledWith(
          "env-42",
        );
      });
    });
  });
});
