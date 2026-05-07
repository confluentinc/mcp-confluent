import { DeleteTopicsHandler } from "@src/confluent/tools/handlers/kafka/delete-topics-handler.js";
import {
  bareRuntime,
  CCLOUD_OAUTH_CONNECTION_ID,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRestOnlyRuntime,
  kafkaRuntime,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("delete-topics-handler.ts", () => {
  describe("DeleteTopicsHandler", () => {
    const handler = new DeleteTopicsHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with kafka.bootstrap_servers", () => {
        expect(handler.enabledConnectionIds(kafkaRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a kafka block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });

      it("should return an empty array for a kafka block without bootstrap_servers", () => {
        expect(handler.enabledConnectionIds(kafkaRestOnlyRuntime())).toEqual(
          [],
        );
      });

      it("should return the connection id when the connection is OAuth-typed", () => {
        expect(handler.enabledConnectionIds(ccloudOAuthRuntime())).toEqual([
          CCLOUD_OAUTH_CONNECTION_ID,
        ]);
      });
    });

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
