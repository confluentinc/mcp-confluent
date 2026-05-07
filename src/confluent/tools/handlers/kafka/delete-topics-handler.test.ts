import { DeleteTopicsHandler } from "@src/confluent/tools/handlers/kafka/delete-topics-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

describe("delete-topics-handler.ts", () => {
  describe("DeleteTopicsHandler", () => {
    const handler = new DeleteTopicsHandler();

    describe("handle()", () => {
      it("should report success when admin.deleteTopics resolves", async () => {
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.deleteTopics.mockResolvedValue(undefined);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { topicNames: ["smoke"] },
          outcome: { resolves: "Deleted Kafka topics: smoke" },
          clientManager,
        });
      });

      it("should let admin errors propagate (no try/catch around the destructive op)", async () => {
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.deleteTopics.mockRejectedValue(
          new Error("not authorized to delete topics"),
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { topicNames: ["smoke"] },
          outcome: { throws: "not authorized to delete topics" },
        });
      });
    });
  });
});
