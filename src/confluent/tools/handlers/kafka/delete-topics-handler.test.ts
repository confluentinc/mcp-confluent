import { DeleteTopicsHandler } from "@src/confluent/tools/handlers/kafka/delete-topics-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
  runtimeWithDecoy,
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

      it("should route to the explicitly addressed connection in a multi-connection config", async () => {
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.deleteTopics.mockResolvedValue(undefined);

        const { runtime, decoyClientManager } = runtimeWithDecoy(
          { kafka: { bootstrap_servers: "broker:9092" } },
          DEFAULT_CONNECTION_ID,
          clientManager,
        );

        await assertHandleCase({
          handler,
          runtime,
          args: { topicNames: ["smoke"], connectionId: DEFAULT_CONNECTION_ID },
          outcome: { resolves: "Deleted Kafka topics: smoke" },
          clientManager,
          untouchedClientManager: decoyClientManager,
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
