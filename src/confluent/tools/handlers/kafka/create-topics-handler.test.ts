import { MCPServerConfiguration } from "@src/config/index.js";
import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import { OAuthClientManager } from "@src/confluent/oauth-client-manager.js";
import { CreateTopicsHandler } from "@src/confluent/tools/handlers/kafka/create-topics-handler.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";

const CONN_ID = "env-connection";

function directRuntime() {
  const manager = createMockInstance(DirectClientManager);
  const config = new MCPServerConfiguration({
    connections: {
      [CONN_ID]: {
        type: "direct",
        kafka: {
          bootstrap_servers: "broker:9092",
          cluster_id: "lkc-direct",
          env_id: "env-direct",
        },
      } as never,
    },
  });
  return {
    runtime: new ServerRuntime(config, { [CONN_ID]: manager }),
    manager,
  };
}

function oauthRuntime() {
  const manager = createMockInstance(OAuthClientManager);
  const config = new MCPServerConfiguration({
    connections: {
      [CONN_ID]: { type: "oauth", development_env: "devel" } as never,
    },
  });
  return {
    runtime: new ServerRuntime(config, { [CONN_ID]: manager }),
    manager,
  };
}

describe("CreateTopicsHandler", () => {
  describe("enabledConnectionIds", () => {
    it("includes the connection id when kafka block is present (direct)", () => {
      const { runtime } = directRuntime();
      expect(new CreateTopicsHandler().enabledConnectionIds(runtime)).toEqual([
        CONN_ID,
      ]);
    });

    it("includes the connection id under OAuth", () => {
      const { runtime } = oauthRuntime();
      expect(new CreateTopicsHandler().enabledConnectionIds(runtime)).toEqual([
        CONN_ID,
      ]);
    });
  });

  describe("handle", () => {
    it("under direct, calls getKafkaAdminClient(undefined, undefined) and createTopics with topic shape", async () => {
      const { runtime, manager } = directRuntime();
      const createTopics = vi.fn().mockResolvedValue(true);
      manager.getKafkaAdminClient.mockResolvedValue({ createTopics } as never);

      const result = await new CreateTopicsHandler().handle(runtime, {
        topics: [{ topic: "my-topic", numPartitions: 3 }],
      });

      expect(manager.getKafkaAdminClient).toHaveBeenCalledWith(
        undefined,
        undefined,
      );
      expect(createTopics).toHaveBeenCalledWith({
        topics: [{ topic: "my-topic", numPartitions: 3 }],
      });
      const item = result.content[0]!;
      if (item.type !== "text") throw new Error("expected text content");
      expect(item.text).toContain("my-topic");
      expect(result.isError).toBeFalsy();
    });

    it("under OAuth, calls getKafkaAdminClient with arg-provided cluster_id/env_id", async () => {
      const { runtime, manager } = oauthRuntime();
      const createTopics = vi.fn().mockResolvedValue(true);
      manager.getKafkaAdminClient.mockResolvedValue({ createTopics } as never);

      await new CreateTopicsHandler().handle(runtime, {
        cluster_id: "lkc-abc",
        environment_id: "env-1",
        topics: [{ topic: "oauth-topic" }],
      });

      expect(manager.getKafkaAdminClient).toHaveBeenCalledWith(
        "lkc-abc",
        "env-1",
      );
      expect(createTopics).toHaveBeenCalledWith({
        topics: [{ topic: "oauth-topic", numPartitions: undefined }],
      });
    });

    it("under OAuth with missing args, returns error response with discovery hint", async () => {
      const { runtime } = oauthRuntime();
      const result = await new CreateTopicsHandler().handle(runtime, {
        topics: [{ topic: "some-topic" }],
      });
      expect(result.isError).toBe(true);
      const item = result.content[0]!;
      if (item.type !== "text") throw new Error("expected text content");
      expect(item.text).toMatch(/cluster_id.*environment_id.*list-clusters/i);
    });

    it("when createTopics returns false, returns error response listing topic names", async () => {
      const { runtime, manager } = directRuntime();
      const fakeAdmin = {
        createTopics: vi.fn().mockResolvedValue(false),
      } as never;
      manager.getKafkaAdminClient.mockResolvedValue(fakeAdmin);

      const result = await new CreateTopicsHandler().handle(runtime, {
        topics: [{ topic: "fail-topic-1" }, { topic: "fail-topic-2" }],
      });

      expect(result.isError).toBe(true);
      const item = result.content[0]!;
      if (item.type !== "text") throw new Error("expected text content");
      expect(item.text).toContain("fail-topic-1");
      expect(item.text).toContain("fail-topic-2");
    });
  });
});
