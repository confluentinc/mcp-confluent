import { RemoveTagFromEntityHandler } from "@src/confluent/tools/handlers/catalog/remove-tag-from-entity.js";
import { runtimeWith } from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

const ARGS = {
  tagName: "PII",
  typeName: "kafka_topic",
  qualifiedName: "lsrc-x:lkc-y:my-topic",
};

describe("remove-tag-from-entity.ts", () => {
  describe("RemoveTagFromEntityHandler", () => {
    const handler = new RemoveTagFromEntityHandler();

    it("should resolve with the removal status on success", async () => {
      const clientManager = getMockedClientManager();
      clientManager
        .getConfluentCloudSchemaRegistryRestClient()
        .DELETE.mockResolvedValue({ response: { status: 204 } });
      await assertHandleCase({
        handler,
        runtime: runtimeWith({}, "default", clientManager),
        args: ARGS,
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
        runtime: runtimeWith({}, "default", clientManager),
        args: ARGS,
        outcome: {
          resolves: "Failed to remove tag from entity",
          isError: true,
        },
        clientManager,
      });
    });

    it("should throw a ZodError when tagName is empty", async () => {
      await assertHandleCase({
        handler,
        runtime: runtimeWith({}, "default", getMockedClientManager()),
        args: { ...ARGS, tagName: "" },
        outcome: { throws: "ZodError" },
      });
    });
  });
});
