import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
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

describe("list-topics-handler.ts", () => {
  describe("ListTopicsHandler", () => {
    const handler = new ListTopicsHandler();

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
