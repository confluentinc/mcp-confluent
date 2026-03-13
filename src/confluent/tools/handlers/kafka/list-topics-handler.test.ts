import sinon from "sinon";
import { describe, expect, it } from "vitest";
import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";

describe("ListTopicsHandler", () => {
  const handler = new ListTopicsHandler();

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
    const stub = sinon.createStubInstance(DefaultClientManager);
    const topics = ["topic-a", "topic-b", "topic-c"];
    // partial mock — only the method under test is needed
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stub.getAdminClient.resolves({ listTopics: async () => topics } as any);

    const result = await handler.handle(stub, {});

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!;
    expect(text.type).toBe("text");
    expect((text as { type: "text"; text: string }).text).toContain("topic-a");
    expect((text as { type: "text"; text: string }).text).toContain("topic-b");
    expect((text as { type: "text"; text: string }).text).toContain("topic-c");
  });

  it("should return an empty list when no topics exist", async () => {
    const stub = sinon.createStubInstance(DefaultClientManager);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    stub.getAdminClient.resolves({ listTopics: async () => [] } as any);

    const result = await handler.handle(stub, {});

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Kafka topics:");
  });

  it("should propagate errors from the admin client", async () => {
    const stub = sinon.createStubInstance(DefaultClientManager);
    stub.getAdminClient.rejects(new Error("connection refused"));

    await expect(handler.handle(stub, {})).rejects.toThrow(
      "connection refused",
    );
  });
});
