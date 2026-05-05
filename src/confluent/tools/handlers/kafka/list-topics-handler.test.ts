import { MCPServerConfiguration } from "@src/config/index.js";
import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import { OAuthClientManager } from "@src/confluent/oauth-client-manager.js";
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
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

describe("ListTopicsHandler", () => {
  describe("enabledConnectionIds", () => {
    it("includes the connection id when kafka block is present (direct)", () => {
      const { runtime } = directRuntime();
      expect(new ListTopicsHandler().enabledConnectionIds(runtime)).toEqual([
        CONN_ID,
      ]);
    });

    it("includes the connection id under OAuth", () => {
      const { runtime } = oauthRuntime();
      expect(new ListTopicsHandler().enabledConnectionIds(runtime)).toEqual([
        CONN_ID,
      ]);
    });
  });

  describe("handle", () => {
    it("under direct, calls getKafkaAdminClient with undefined args (manager ignores them)", async () => {
      const { runtime, manager } = directRuntime();
      const fakeAdmin = {
        listTopics: vi.fn().mockResolvedValue(["t1"]),
      } as never;
      manager.getKafkaAdminClient.mockResolvedValue(fakeAdmin);

      const result = await new ListTopicsHandler().handle(runtime, {});

      expect(manager.getKafkaAdminClient).toHaveBeenCalledWith(
        undefined,
        undefined,
      );
      const item = result.content[0]!;
      if (item.type !== "text") throw new Error("expected text content");
      expect(item.text).toContain("t1");
    });

    it("under OAuth, calls getKafkaAdminClient with arg-provided cluster_id/env_id", async () => {
      const { runtime, manager } = oauthRuntime();
      const fakeAdmin = {
        listTopics: vi.fn().mockResolvedValue(["t1"]),
      } as never;
      manager.getKafkaAdminClient.mockResolvedValue(fakeAdmin);

      await new ListTopicsHandler().handle(runtime, {
        cluster_id: "lkc-abc",
        environment_id: "env-1",
      });

      expect(manager.getKafkaAdminClient).toHaveBeenCalledWith(
        "lkc-abc",
        "env-1",
      );
    });

    it("under OAuth with missing args, returns an error response with discovery hint", async () => {
      const { runtime } = oauthRuntime();
      const result = await new ListTopicsHandler().handle(runtime, {});
      expect(result.isError).toBe(true);
      const item = result.content[0]!;
      if (item.type !== "text") throw new Error("expected text content");
      expect(item.text).toMatch(/cluster_id.*environment_id.*list-clusters/i);
    });
  });
});
