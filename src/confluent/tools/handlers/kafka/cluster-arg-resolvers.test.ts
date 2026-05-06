import { MCPServerConfiguration } from "@src/config/index.js";
import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import {
  disposeIfOAuth,
  resolveKafkaClusterArgs,
} from "@src/confluent/tools/handlers/kafka/cluster-arg-resolvers.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";

const CONN_ID = "env-connection";

function directRuntime(
  connOverrides: Record<string, unknown> = {},
): ServerRuntime {
  const config = new MCPServerConfiguration({
    connections: {
      [CONN_ID]: { type: "direct", ...connOverrides } as never,
    },
  });
  return new ServerRuntime(config, {
    [CONN_ID]: createMockInstance(DirectClientManager),
  });
}

function oauthRuntime(): ServerRuntime {
  const config = new MCPServerConfiguration({
    connections: {
      [CONN_ID]: { type: "oauth", ccloud_env: "devel" } as never,
    },
  });
  return new ServerRuntime(config, {
    [CONN_ID]: createMockInstance(DirectClientManager),
  });
}

describe("resolveKafkaClusterArgs", () => {
  it("under direct, returns undefined regardless of args or conn config", () => {
    // Direct's manager ignores cluster args; resolver returns undefined for both,
    // and the handler passes them through to the manager which uses its single instance.
    const runtime = directRuntime({
      kafka: { bootstrap_servers: "broker:9092", cluster_id: "lkc-direct" },
    });
    expect(
      resolveKafkaClusterArgs(
        { cluster_id: "lkc-arg", environment_id: "env-arg" },
        runtime,
        CONN_ID,
      ),
    ).toEqual({ clusterId: undefined, envId: undefined });
    expect(resolveKafkaClusterArgs({}, runtime, CONN_ID)).toEqual({
      clusterId: undefined,
      envId: undefined,
    });
  });

  it("under OAuth with both args, returns them", () => {
    const runtime = oauthRuntime();
    expect(
      resolveKafkaClusterArgs(
        { cluster_id: "lkc-abc", environment_id: "env-1" },
        runtime,
        CONN_ID,
      ),
    ).toEqual({ clusterId: "lkc-abc", envId: "env-1" });
  });

  it("under OAuth with missing cluster_id, throws discovery hint", () => {
    const runtime = oauthRuntime();
    expect(() =>
      resolveKafkaClusterArgs({ environment_id: "env-1" }, runtime, CONN_ID),
    ).toThrow(/cluster_id.*environment_id.*required.*list-clusters/i);
  });

  it("under OAuth with missing environment_id, throws discovery hint", () => {
    const runtime = oauthRuntime();
    expect(() =>
      resolveKafkaClusterArgs({ cluster_id: "lkc-abc" }, runtime, CONN_ID),
    ).toThrow(/cluster_id.*environment_id.*required.*list-clusters/i);
  });
});

describe("disposeIfOAuth", () => {
  it("should not call disconnect on a direct connection", async () => {
    const runtime = directRuntime();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    await disposeIfOAuth(runtime, CONN_ID, { disconnect });
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("should call disconnect on an OAuth connection", async () => {
    const runtime = oauthRuntime();
    const disconnect = vi.fn().mockResolvedValue(undefined);
    await disposeIfOAuth(runtime, CONN_ID, { disconnect });
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("should swallow and log disconnect errors", async () => {
    const runtime = oauthRuntime();
    const warnSpy = vi
      .spyOn(logger, "warn")
      .mockImplementation(() => undefined);
    const disconnect = vi
      .fn()
      .mockRejectedValue(new Error("broker connection lost"));
    await expect(
      disposeIfOAuth(runtime, CONN_ID, { disconnect }),
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
