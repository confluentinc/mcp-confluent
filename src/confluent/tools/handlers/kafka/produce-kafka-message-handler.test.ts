import { ProduceKafkaMessageHandler } from "@src/confluent/tools/handlers/kafka/produce-kafka-message-handler.js";
import {
  bareRuntime,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRestOnlyRuntime,
  kafkaRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("produce-kafka-message-handler.ts", () => {
  describe("ProduceKafkaMessageHandler", () => {
    const handler = new ProduceKafkaMessageHandler();

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
          DEFAULT_CONNECTION_ID,
        ]);
      });
    });
  });
});
