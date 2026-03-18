import { KafkaJS } from "@confluentinc/kafka-javascript";
import { TextContent } from "@modelcontextprotocol/sdk/types.js";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  createStubAdmin,
  createStubClientManager,
  StubbedAdmin,
} from "@src/test-utils/stubs/index.js";
import { SinonStubbedInstance } from "sinon";
import { beforeEach, describe, expect, it } from "vitest";

describe("ListTopicsHandler", () => {
  const handler = new ListTopicsHandler();
  let clientManager: SinonStubbedInstance<DefaultClientManager>;
  let admin: StubbedAdmin;

  beforeEach(() => {
    admin = createStubAdmin();
    clientManager = createStubClientManager();
    clientManager.getAdminClient.resolves(admin as KafkaJS.Admin);
  });

  it("should return correct tool name and description", () => {
    const config = handler.getToolConfig();
    expect(config.name).toBe(ToolName.LIST_TOPICS);
    expect(config.description).toMatch(/topic/i);
  });

  it("should require Kafka credentials and bootstrap servers", () => {
    const vars = handler.getRequiredEnvVars();

    expect(vars).toContain("KAFKA_API_KEY");
    expect(vars).toContain("KAFKA_API_SECRET");
    expect(vars).toContain("BOOTSTRAP_SERVERS");
  });

  it("should return a list of topic names on success", async () => {
    admin.listTopics.resolves(["topic-a", "topic-b", "topic-c"]);

    const result = await handler.handle(clientManager, {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("topic-a");
    expect(text).toContain("topic-b");
    expect(text).toContain("topic-c");
  });

  it("should return an empty list when no topics exist", async () => {
    const result = await handler.handle(clientManager, {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as TextContent).text;
    expect(text).toContain("Kafka topics:");
  });

  it("should propagate errors from the admin client", async () => {
    clientManager.getAdminClient.rejects(new Error("connection refused"));

    await expect(handler.handle(clientManager, {})).rejects.toThrow(
      "connection refused",
    );
  });
});
