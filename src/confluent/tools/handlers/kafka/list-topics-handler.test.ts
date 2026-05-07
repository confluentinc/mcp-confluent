import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

describe("list-topics-handler.ts", () => {
  describe("ListTopicsHandler", () => {
    const handler = new ListTopicsHandler();

    describe("handle()", () => {
      it("should return the topic list when the admin call resolves", async () => {
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.listTopics.mockResolvedValue(["topic-a", "topic-b"]);

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: { resolves: "Kafka topics: topic-a,topic-b" },
          clientManager,
        });
      });

      it("should let admin errors propagate (no try/catch around the read op)", async () => {
        const clientManager = getMockedClientManager();
        const admin = await clientManager.getAdminClient();
        admin.listTopics.mockRejectedValue(new Error("broker unreachable"));

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            { kafka: { bootstrap_servers: "broker:9092" } },
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: { throws: "broker unreachable" },
        });
      });
    });
  });
});
