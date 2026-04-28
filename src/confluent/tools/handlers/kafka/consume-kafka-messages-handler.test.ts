import { ConsumeKafkaMessagesHandler } from "@src/confluent/tools/handlers/kafka/consume-kafka-messages-handler.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("consume-kafka-messages-handler.ts", () => {
  describe("ConsumeKafkaMessagesHandler", () => {
    const handler = new ConsumeKafkaMessagesHandler();

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
