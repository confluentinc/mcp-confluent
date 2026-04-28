import { type DirectConnectionConfig } from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import {
  constructClientManagerForConnection,
  DefaultClientManager,
} from "@src/confluent/client-manager.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { envFactory } from "@tests/factories/env.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

function connWith(
  fields: Omit<DirectConnectionConfig, "type">,
): DirectConnectionConfig {
  return { type: "direct", ...fields };
}

describe("constructClientManagerForConnection()", () => {
  it("should return a DefaultClientManager instance", () => {
    const manager = constructClientManagerForConnection(
      connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
    );
    expect(manager).toBeInstanceOf(DefaultClientManager);
  });

  it("should always set client.id to mcp-confluent", () => {
    const manager = constructClientManagerForConnection(
      connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
    );
    expect(manager["kafkaConfig"]["client.id"]).toBe("mcp-confluent");
  });

  it("should set bootstrap.servers from the kafka block", () => {
    const manager = constructClientManagerForConnection(
      connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
    );
    expect(manager["kafkaConfig"]["bootstrap.servers"]).toBe("broker:9092");
  });

  it("should include SASL config when the kafka block has auth", () => {
    const manager = constructClientManagerForConnection(
      connWith({
        kafka: {
          bootstrap_servers: "broker:9092",
          auth: { type: "api_key", key: "the-key", secret: "the-secret" },
        },
      }),
    );
    expect(manager["kafkaConfig"]["security.protocol"]).toBe("sasl_ssl");
    expect(manager["kafkaConfig"]["sasl.username"]).toBe("the-key");
    expect(manager["kafkaConfig"]["sasl.password"]).toBe("the-secret");
  });

  it("should omit SASL config when the kafka block has no auth", () => {
    const manager = constructClientManagerForConnection(
      connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
    );
    expect(manager["kafkaConfig"]["security.protocol"]).toBeUndefined();
  });

  it("should omit SASL config when there is no kafka block", () => {
    const manager = constructClientManagerForConnection(
      connWith({
        confluent_cloud: {
          endpoint: "https://api.confluent.cloud",
          auth: { type: "api_key", key: "k", secret: "s" },
        },
      }),
    );
    expect(manager["kafkaConfig"]["security.protocol"]).toBeUndefined();
  });

  it("should spread kafka extra_properties into the GlobalConfig", () => {
    const manager = constructClientManagerForConnection(
      connWith({
        kafka: {
          bootstrap_servers: "broker:9092",
          extra_properties: { "socket.timeout.ms": "5000" },
        },
      }),
    );
    expect(manager["kafkaConfig"]["socket.timeout.ms"]).toBe("5000");
  });

  it("should set confluentCloudBaseUrl from the confluent_cloud block endpoint", () => {
    const manager = constructClientManagerForConnection(
      connWith({
        confluent_cloud: {
          endpoint: "https://my.cloud.api",
          auth: { type: "api_key", key: "k", secret: "s" },
        },
      }),
    );
    expect(manager["confluentCloudBaseUrl"]).toBe("https://my.cloud.api");
  });

  it("should set confluentCloudBaseUrl to https://api.confluent.cloud when the block uses the default endpoint", () => {
    const manager = constructClientManagerForConnection(
      connWith({
        confluent_cloud: {
          endpoint: "https://api.confluent.cloud",
          auth: { type: "api_key", key: "k", secret: "s" },
        },
      }),
    );
    expect(manager["confluentCloudBaseUrl"]).toBe(
      "https://api.confluent.cloud",
    );
  });

  it("should default confluentCloudBaseUrl to https://api.confluent.cloud when there is no confluent_cloud block", () => {
    const manager = constructClientManagerForConnection(
      connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
    );
    expect(manager["confluentCloudBaseUrl"]).toBe(
      "https://api.confluent.cloud",
    );
  });

  it("should set confluentCloudTableflowBaseUrl to https://api.confluent.cloud when only tableflow is configured", () => {
    const manager = constructClientManagerForConnection(
      connWith({
        tableflow: { auth: { type: "api_key", key: "k", secret: "s" } },
      }),
    );
    expect(manager["confluentCloudTableflowBaseUrl"]).toBe(
      "https://api.confluent.cloud",
    );
  });

  it("should set confluentCloudTelemetryBaseUrl from the telemetry block", () => {
    const manager = constructClientManagerForConnection(
      connWith({
        telemetry: {
          endpoint: "https://my.telemetry.api",
          auth: { type: "api_key", key: "k", secret: "s" },
        },
      }),
    );
    expect(manager["confluentCloudTelemetryBaseUrl"]).toBe(
      "https://my.telemetry.api",
    );
  });

  it("should leave confluentCloudTelemetryBaseUrl undefined when there is no telemetry block", () => {
    const manager = constructClientManagerForConnection(
      connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
    );
    expect(manager["confluentCloudTelemetryBaseUrl"]).toBeUndefined();
  });
});

describe("ServerRuntime", () => {
  const config = new MCPServerConfiguration({
    connections: {
      "test-conn": connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
    },
  });
  const env = envFactory();

  describe("constructor", () => {
    it("should store config, clientManagers, and env as-is", () => {
      const cm = createMockInstance(DefaultClientManager);
      const runtime = new ServerRuntime(config, { "test-conn": cm }, env);
      expect(runtime.config).toBe(config);
      expect(runtime.clientManagers).toStrictEqual({ "test-conn": cm });
      expect(runtime.env).toBe(env);
    });
  });

  describe("get clientManager()", () => {
    it("should return the sole client manager", () => {
      const cm = createMockInstance(DefaultClientManager);
      const runtime = new ServerRuntime(config, { "test-conn": cm }, env);
      expect(runtime.clientManager).toBe(cm);
    });

    it("should throw when clientManagers is empty", () => {
      const runtime = new ServerRuntime(config, {}, env);
      expect(() => runtime.clientManager).toThrow(
        "ServerRuntime has no client managers",
      );
    });

    it("should throw when clientManagers has more than one entry", () => {
      const cm1 = createMockInstance(DefaultClientManager);
      const cm2 = createMockInstance(DefaultClientManager);
      const runtime = new ServerRuntime(
        config,
        { conn1: cm1, conn2: cm2 },
        env,
      );
      expect(() => runtime.clientManager).toThrow(
        "ServerRuntime has multiple client managers",
      );
    });
  });

  describe("fromConfig()", () => {
    it("should create a DefaultClientManager for each connection", () => {
      const twoConnConfig = new MCPServerConfiguration({
        connections: {
          conn1: connWith({ kafka: { bootstrap_servers: "broker1:9092" } }),
          conn2: connWith({
            confluent_cloud: {
              endpoint: "https://api.confluent.cloud",
              auth: { type: "api_key", key: "k", secret: "s" },
            },
          }),
        },
      });
      const runtime = ServerRuntime.fromConfig(twoConnConfig, env);
      expect(Object.keys(runtime.clientManagers)).toStrictEqual([
        "conn1",
        "conn2",
      ]);
      expect(runtime.clientManagers["conn1"]).toBeInstanceOf(
        DefaultClientManager,
      );
      expect(runtime.clientManagers["conn2"]).toBeInstanceOf(
        DefaultClientManager,
      );
    });

    it("should store the config and env on the returned runtime", () => {
      const runtime = ServerRuntime.fromConfig(config, env);
      expect(runtime.config).toBe(config);
      expect(runtime.env).toBe(env);
    });
  });
});
