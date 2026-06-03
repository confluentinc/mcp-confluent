import { AddTagToTopicHandler } from "@src/confluent/tools/handlers/catalog/add-tags-to-topic.js";
import { runtimeWith } from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

const TAG_ASSIGNMENT = {
  entityType: "kafka_topic",
  entityName: "lsrc-x:lkc-y:my-topic",
  typeName: "PII",
};

describe("add-tags-to-topic.ts", () => {
  describe("AddTagToTopicHandler", () => {
    const handler = new AddTagToTopicHandler();

    it("should resolve with the assignment result on success", async () => {
      const clientManager = getMockedClientManager();
      clientManager
        .getConfluentCloudSchemaRegistryRestClient()
        .POST.mockResolvedValue({ data: [TAG_ASSIGNMENT] });
      await assertHandleCase({
        handler,
        runtime: runtimeWith({}, "default", clientManager),
        args: { tagAssignments: [TAG_ASSIGNMENT] },
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
        runtime: runtimeWith({}, "default", clientManager),
        args: { tagAssignments: [TAG_ASSIGNMENT] },
        outcome: { resolves: "Failed to assign tag", isError: true },
        clientManager,
      });
    });

    it("should throw a ZodError when tagAssignments is empty", async () => {
      await assertHandleCase({
        handler,
        runtime: runtimeWith({}, "default", getMockedClientManager()),
        args: { tagAssignments: [] },
        outcome: { throws: "ZodError" },
      });
    });
  });
});
