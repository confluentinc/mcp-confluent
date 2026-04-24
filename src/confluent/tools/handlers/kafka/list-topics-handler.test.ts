import { KafkaJS } from "@confluentinc/kafka-javascript";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
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

    describe("getRequiredEnvVars()", () => {
      it("should only require bootstrap servers", () => {
        const vars = handler.getRequiredEnvVars();

        expect(vars).toEqual(["BOOTSTRAP_SERVERS"]);
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
