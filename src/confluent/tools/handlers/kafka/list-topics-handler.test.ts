import { KafkaJS } from "@confluentinc/kafka-javascript";
import { DirectClientManager } from "@src/confluent/client-manager.js";
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  kafkaRestOnlyRuntime,
  kafkaRuntime,
  runtimeWith,
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
    let clientManager: Mocked<DirectClientManager>;
    let admin: MockedAdmin;

    beforeEach(() => {
      admin = createMockAdmin();
      clientManager = createMockInstance(DirectClientManager);
      clientManager.getAdminClient.mockResolvedValue(admin as KafkaJS.Admin);
    });

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
    });

    describe("handle()", () => {
      it("should propagate errors from the admin client", async () => {
        clientManager.getAdminClient.mockRejectedValue(
          new Error("connection refused"),
        );

        await expect(
          handler.handle(
            runtimeWith(
              { kafka: { bootstrap_servers: "broker:9092" } },
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            {},
          ),
        ).rejects.toThrow("connection refused");
      });
    });
  });
});
