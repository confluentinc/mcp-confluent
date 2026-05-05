import { MCPServerConfiguration } from "@src/config/index.js";
import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import {
  resolveKafkaClusterArgs,
  resolveSchemaRegistryClusterArgs,
} from "@src/confluent/tools/handlers/kafka/cluster-arg-resolvers.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

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

describe("resolveSchemaRegistryClusterArgs", () => {
  it("under direct, returns undefined regardless of args", () => {
    const runtime = directRuntime();
    expect(
      resolveSchemaRegistryClusterArgs(
        { schema_registry_cluster_id: "lsrc-arg", environment_id: "env-arg" },
        runtime,
        CONN_ID,
      ),
    ).toEqual({ clusterId: undefined, envId: undefined });
    expect(resolveSchemaRegistryClusterArgs({}, runtime, CONN_ID)).toEqual({
      clusterId: undefined,
      envId: undefined,
    });
  });

  it("under OAuth with both args, returns them", () => {
    const runtime = oauthRuntime();
    expect(
      resolveSchemaRegistryClusterArgs(
        {
          schema_registry_cluster_id: "lsrc-abc",
          environment_id: "env-1",
        },
        runtime,
        CONN_ID,
      ),
    ).toEqual({ clusterId: "lsrc-abc", envId: "env-1" });
  });

  it("under OAuth with missing args, throws discovery hint", () => {
    const runtime = oauthRuntime();
    expect(() =>
      resolveSchemaRegistryClusterArgs({}, runtime, CONN_ID),
    ).toThrow(
      /schema_registry_cluster_id.*environment_id.*required.*list-schema-registry-clusters/i,
    );
  });
});
