import { KafkaJS } from "@confluentinc/kafka-javascript";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import { envFactory } from "@tests/factories/env.js";
import { runtimeWith } from "@tests/factories/runtime.js";
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

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID when BOOTSTRAP_SERVERS is set", () => {
        const runtime = runtimeWith(
          envFactory({ BOOTSTRAP_SERVERS: "broker:9092" }),
        );
        expect(handler.enabledConnectionIds(runtime)).toEqual(["default"]);
      });

      it("should return an empty array when BOOTSTRAP_SERVERS is absent", () => {
        const runtime = runtimeWith(envFactory());
        expect(handler.enabledConnectionIds(runtime)).toEqual([]);
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
