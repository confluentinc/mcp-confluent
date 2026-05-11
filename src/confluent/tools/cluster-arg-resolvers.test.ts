import { KafkaJS } from "@confluentinc/kafka-javascript";
import { DEFAULT_CONNECTION_NAME } from "@src/config/env-config.js";
import { MCPServerConfiguration } from "@src/config/index.js";
import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import {
  disposeIfOAuth,
  formatKafkaError,
  resolveEnvArg,
  resolveKafkaClusterArgs,
  resolveKafkaRestArgs,
} from "@src/confluent/tools/cluster-arg-resolvers.js";
import { logger } from "@src/logger.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";

const CONN_ID = DEFAULT_CONNECTION_NAME;

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
        { clusterId: "lkc-arg", environmentId: "env-arg" },
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
        { clusterId: "lkc-abc", environmentId: "env-1" },
        runtime,
        CONN_ID,
      ),
    ).toEqual({ clusterId: "lkc-abc", envId: "env-1" });
  });

  it("under OAuth with missing clusterId, throws discovery hint", () => {
    const runtime = oauthRuntime();
    expect(() =>
      resolveKafkaClusterArgs({ environmentId: "env-1" }, runtime, CONN_ID),
    ).toThrow(/clusterId.*environmentId.*required.*list-clusters/i);
  });

  it("under OAuth with missing environmentId, throws discovery hint", () => {
    const runtime = oauthRuntime();
    expect(() =>
      resolveKafkaClusterArgs({ clusterId: "lkc-abc" }, runtime, CONN_ID),
    ).toThrow(/clusterId.*environmentId.*required.*list-clusters/i);
  });
});

describe("resolveKafkaRestArgs", () => {
  it("under direct, uses arg when provided", () => {
    const runtime = directRuntime({
      kafka: {
        rest_endpoint: "https://x",
        cluster_id: "lkc-cfg",
        auth: { type: "api_key", key: "k", secret: "s" },
      },
    });
    expect(
      resolveKafkaRestArgs({ clusterId: "lkc-arg" }, runtime, CONN_ID),
    ).toEqual({ clusterId: "lkc-arg", envId: undefined });
  });

  it("under direct, falls back to conn.kafka.cluster_id when arg is absent", () => {
    const runtime = directRuntime({
      kafka: {
        rest_endpoint: "https://x",
        cluster_id: "lkc-cfg",
        auth: { type: "api_key", key: "k", secret: "s" },
      },
    });
    expect(resolveKafkaRestArgs({}, runtime, CONN_ID)).toEqual({
      clusterId: "lkc-cfg",
      envId: undefined,
    });
  });

  it("under direct, throws when neither arg nor config provides clusterId", () => {
    const runtime = directRuntime({
      kafka: {
        rest_endpoint: "https://x",
        auth: { type: "api_key", key: "k", secret: "s" },
      },
    });
    expect(() => resolveKafkaRestArgs({}, runtime, CONN_ID)).toThrow(
      /clusterId is required/,
    );
  });

  it("under OAuth with missing environmentId, throws discovery hint", () => {
    const runtime = oauthRuntime();
    expect(() =>
      resolveKafkaRestArgs({ clusterId: "lkc-1" }, runtime, CONN_ID),
    ).toThrow(/clusterId.*environmentId.*required.*OAuth/i);
  });

  it("under OAuth with missing clusterId, throws discovery hint", () => {
    const runtime = oauthRuntime();
    expect(() =>
      resolveKafkaRestArgs({ environmentId: "env-1" }, runtime, CONN_ID),
    ).toThrow(/clusterId.*environmentId.*required.*OAuth/i);
  });

  it("under OAuth, returns both args when supplied", () => {
    const runtime = oauthRuntime();
    expect(
      resolveKafkaRestArgs(
        { clusterId: "lkc-1", environmentId: "env-1" },
        runtime,
        CONN_ID,
      ),
    ).toEqual({ clusterId: "lkc-1", envId: "env-1" });
  });
});

describe("resolveEnvArg", () => {
  it("under direct, returns the arg when provided", () => {
    const runtime = directRuntime({
      kafka: { env_id: "env-from-config" },
    });
    expect(resolveEnvArg({ environmentId: "env-arg" }, runtime, CONN_ID)).toBe(
      "env-arg",
    );
  });

  it("under direct, falls back to conn.kafka.env_id", () => {
    const runtime = directRuntime({
      kafka: { env_id: "env-from-config" },
    });
    expect(resolveEnvArg({}, runtime, CONN_ID)).toBe("env-from-config");
  });

  it("under direct, throws with kafka.env_id hint when no source supplies a value", () => {
    const runtime = directRuntime({});
    expect(() => resolveEnvArg({}, runtime, CONN_ID)).toThrow(
      /environmentId is required.*kafka\.env_id/,
    );
  });

  it("under OAuth, returns the arg when provided", () => {
    expect(
      resolveEnvArg({ environmentId: "env-1" }, oauthRuntime(), CONN_ID),
    ).toBe("env-1");
  });

  it("under OAuth, throws with list-environments hint when arg is missing", () => {
    expect(() => resolveEnvArg({}, oauthRuntime(), CONN_ID)).toThrow(
      /environmentId is required.*list-environments/,
    );
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

describe("formatKafkaError", () => {
  it("should unwrap KafkaJSAggregateError per-topic causes", () => {
    const inner1 = new KafkaJS.KafkaJSCreateTopicError(
      new KafkaJS.KafkaJSError("Topic already exists"),
      "topic-a",
    );
    const inner2 = new KafkaJS.KafkaJSCreateTopicError(
      new KafkaJS.KafkaJSError("Authorization failed"),
      "topic-b",
    );
    const aggregate = new KafkaJS.KafkaJSAggregateError(
      "Topic creation errors",
      [inner1, inner2],
    );
    const result = formatKafkaError(aggregate);
    expect(result).toContain("Topic creation errors");
    expect(result).toContain("- topic-a:");
    expect(result).toContain("Topic already exists");
    expect(result).toContain("- topic-b:");
    expect(result).toContain("Authorization failed");
  });

  it("should include the code on a plain KafkaJSError", () => {
    const err = new KafkaJS.KafkaJSError("connection refused");
    expect(formatKafkaError(err)).toMatch(/Kafka error.*connection refused/);
  });

  it("should fall back to message for a generic Error", () => {
    expect(formatKafkaError(new Error("oh no"))).toBe("oh no");
  });

  it("should fall back to String() for a non-Error value", () => {
    expect(formatKafkaError("just a string")).toBe("just a string");
    expect(formatKafkaError(42)).toBe("42");
  });
});
