import { AlterTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/alter-topic-config.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRestOnlyRuntime,
  kafkaRestRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("alter-topic-config.ts", () => {
  describe("AlterTopicConfigHandler", () => {
    const handler = new AlterTopicConfigHandler();

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
