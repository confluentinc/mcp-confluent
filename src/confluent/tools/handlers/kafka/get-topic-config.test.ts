import { GetTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/get-topic-config.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRestOnlyRuntime,
  kafkaRestRuntime,
} from "@tests/factories/runtime.js";
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
  });
});
