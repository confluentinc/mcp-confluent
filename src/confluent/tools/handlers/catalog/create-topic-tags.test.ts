import { CreateTopicTagsHandler } from "@src/confluent/tools/handlers/catalog/create-topic-tags.js";
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

const VALID_ARGS = { tags: [{ tagName: "PII" }] };

// Each case runs against runtimeWithDecoy, so assertHandleCase routes to the
// real connection and asserts the decoy's client manager stays untouched.
describe("create-topic-tags.ts", () => {
  describe("CreateTopicTagsHandler", () => {
    const handler = new CreateTopicTagsHandler();

    describe("handle()", () => {
      it("should resolve with a success message when the tag is created", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudSchemaRegistryRestClient()
          .POST.mockResolvedValue({ data: [{ name: "PII" }] });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CATALOG_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: VALID_ARGS,
          outcome: { resolves: "Successfully created tag" },
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
          outcome: { resolves: "Failed to create tag", isError: true },
          clientManager,
        });
      });

      it("should throw a ZodError when tags is absent", async () => {
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
