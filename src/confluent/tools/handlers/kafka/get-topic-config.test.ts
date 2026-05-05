import { GetTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/get-topic-config.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  KAFKA_CONN,
  kafkaRestOnlyRuntime,
  kafkaRestRuntime,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("get-topic-config.ts", () => {
  describe("GetTopicConfigHandler", () => {
    const handler = new GetTopicConfigHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with kafka.rest_endpoint and auth", () => {
        expect(handler.enabledConnectionIds(kafkaRestRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a kafka block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });

      it("should return an empty array for a kafka REST connection without auth", () => {
        expect(handler.enabledConnectionIds(kafkaRestOnlyRuntime())).toEqual(
          [],
        );
      });
    });

    describe("handle()", () => {
      const cases: HandleCaseWithConn[] = [
        {
          label: "throws ZodError when topicName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label: "throws when clusterId is absent and not in connection config",
          args: { topicName: "my-topic" },
          outcome: { throws: "Kafka Cluster ID is required" },
          connectionConfig: {},
        },
        {
          label:
            "uses cluster_id from connection config when clusterId arg is absent",
          args: { topicName: "my-topic" },
          outcome: { resolves: "Topic configuration for 'my-topic'" },
        },
        {
          label: "uses clusterId arg over connection config cluster_id",
          args: { topicName: "my-topic", clusterId: "lkc-from-args" },
          outcome: { resolves: "Topic configuration for 'my-topic'" },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({
          args,
          outcome,
          responseData,
          connectionConfig = KAFKA_CONN,
        }) => {
          const { clientManager, clientGetters } =
            stubClientGetters(responseData);
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              connectionConfig,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientGetters,
          });
        },
      );
    });
  });
});
