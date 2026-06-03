import { DeleteTagHandler } from "@src/confluent/tools/handlers/catalog/delete-tag.js";
import { runtimeWith } from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

describe("delete-tag.ts", () => {
  describe("DeleteTagHandler", () => {
    const handler = new DeleteTagHandler();

    it("should resolve with the deletion status on success", async () => {
      const clientManager = getMockedClientManager();
      clientManager
        .getConfluentCloudSchemaRegistryRestClient()
        .DELETE.mockResolvedValue({ response: { status: 204 } });
      await assertHandleCase({
        handler,
        runtime: runtimeWith({}, "default", clientManager),
        args: { tagName: "PII" },
        outcome: { resolves: "Successfully deleted tag: PII. Status: 204" },
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
        runtime: runtimeWith({}, "default", clientManager),
        args: { tagName: "PII" },
        outcome: { resolves: "Failed to delete tag", isError: true },
        clientManager,
      });
    });

    it("should throw a ZodError when tagName is empty", async () => {
      await assertHandleCase({
        handler,
        runtime: runtimeWith({}, "default", getMockedClientManager()),
        args: { tagName: "" },
        outcome: { throws: "ZodError" },
      });
    });
  });
});
