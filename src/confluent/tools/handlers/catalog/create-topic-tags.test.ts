import { CreateTopicTagsHandler } from "@src/confluent/tools/handlers/catalog/create-topic-tags.js";
import { runtimeWith } from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

describe("create-topic-tags.ts", () => {
  describe("CreateTopicTagsHandler", () => {
    const handler = new CreateTopicTagsHandler();

    it("should resolve with the created tag on success", async () => {
      const clientManager = getMockedClientManager();
      clientManager
        .getConfluentCloudSchemaRegistryRestClient()
        .POST.mockResolvedValue({ data: [{ name: "PII" }] });
      await assertHandleCase({
        handler,
        runtime: runtimeWith({}, "default", clientManager),
        args: { tags: [{ tagName: "PII", description: "sensitive" }] },
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
        runtime: runtimeWith({}, "default", clientManager),
        args: { tags: [{ tagName: "PII" }] },
        outcome: { resolves: "Failed to create tag", isError: true },
        clientManager,
      });
    });

    it("should throw a ZodError when tags is empty", async () => {
      await assertHandleCase({
        handler,
        runtime: runtimeWith({}, "default", getMockedClientManager()),
        args: { tags: [] },
        outcome: { throws: "ZodError" },
      });
    });
  });
});
