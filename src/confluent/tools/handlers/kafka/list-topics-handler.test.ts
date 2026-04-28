import { KafkaJS } from "@confluentinc/kafka-javascript";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRuntime,
} from "@tests/factories/runtime.js";
import {
  createMockAdmin,
  createMockInstance,
  type MockedAdmin,
} from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it, type Mocked } from "vitest";

describe("list-topics-handler.ts", () => {
  describe("ListTopicsHandler", () => {
    const handler = new ListTopicsHandler();
    let clientManager: Mocked<DefaultClientManager>;
    let admin: MockedAdmin;

    beforeEach(() => {
      admin = createMockAdmin();
      clientManager = createMockInstance(DefaultClientManager);
      clientManager.getAdminClient.mockResolvedValue(admin as KafkaJS.Admin);
    });

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

    describe("handle()", () => {
      it("should propagate errors from the admin client", async () => {
        clientManager.getAdminClient.mockRejectedValue(
          new Error("connection refused"),
        );

        await expect(handler.handle(clientManager, {})).rejects.toThrow(
          "connection refused",
        );
      });
    });
  });
});
