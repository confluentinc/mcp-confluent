import { KafkaJS } from "@confluentinc/kafka-javascript";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import { createStubAdmin, StubbedAdmin } from "@tests/stubs/index.js";
import sinon from "sinon";
import { beforeEach, describe, expect, it } from "vitest";

describe("list-topics-handler.ts", () => {
  describe("ListTopicsHandler", () => {
    const handler = new ListTopicsHandler();
    let clientManager: sinon.SinonStubbedInstance<DefaultClientManager>;
    let admin: StubbedAdmin;

    beforeEach(() => {
      admin = createStubAdmin();
      clientManager = sinon.createStubInstance(DefaultClientManager);
      clientManager.getAdminClient.resolves(admin as KafkaJS.Admin);
    });

    describe("getRequiredEnvVars()", () => {
      it("should only require bootstrap servers", () => {
        const vars = handler.getRequiredEnvVars();

        expect(vars).toEqual(["BOOTSTRAP_SERVERS"]);
      });
    });

    describe("handle()", () => {
      it("should propagate errors from the admin client", async () => {
        clientManager.getAdminClient.rejects(new Error("connection refused"));

        await expect(handler.handle(clientManager, {})).rejects.toThrow(
          "connection refused",
        );
      });
    });
  });
});
