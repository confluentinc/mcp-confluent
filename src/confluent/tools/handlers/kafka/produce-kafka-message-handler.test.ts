import { ProduceKafkaMessageHandler } from "@src/confluent/tools/handlers/kafka/produce-kafka-message-handler.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("produce-kafka-message-handler.ts", () => {
  describe("ProduceKafkaMessageHandler", () => {
    const handler = new ProduceKafkaMessageHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with a kafka block", () => {
        expect(handler.enabledConnectionIds(kafkaRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a kafka block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });
    });
  });
});
