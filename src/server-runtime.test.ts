import { DEFAULT_CONNECTION_NAME } from "@src/config/env-config.js";
import { type DirectConnectionConfig } from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import {
  constructDirectClientManager,
  DirectClientManager,
} from "@src/confluent/direct-client-manager.js";
import { OAuthClientManager } from "@src/confluent/oauth-client-manager.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

function connWith(
  fields: Omit<DirectConnectionConfig, "type">,
): DirectConnectionConfig {
  return { type: "direct", ...fields };
}

describe("constructDirectClientManager()", () => {
  it("should return a DirectClientManager instance", () => {
    const manager = constructDirectClientManager(
      connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
    );
    expect(manager).toBeInstanceOf(DirectClientManager);
  });

  it("should always set client.id to mcp-confluent", () => {
    const manager = constructDirectClientManager(
      connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
    );
    expect(manager["kafkaConfig"]["client.id"]).toBe("mcp-confluent");
  });

  it("should set bootstrap.servers from the kafka block", () => {
    const manager = constructDirectClientManager(
      connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
    );
    expect(manager["kafkaConfig"]["bootstrap.servers"]).toBe("broker:9092");
  });

  it("should include SASL config when the kafka block has auth", () => {
    const manager = constructDirectClientManager(
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
    const manager = constructDirectClientManager(
      connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
    );
    expect(manager["kafkaConfig"]["security.protocol"]).toBeUndefined();
  });

  it("should omit SASL config when there is no kafka block", () => {
    const manager = constructDirectClientManager(
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
    const manager = constructDirectClientManager(
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
    const manager = constructDirectClientManager(
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
    const manager = constructDirectClientManager(
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
    const manager = constructDirectClientManager(
      connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
    );
    expect(manager["confluentCloudBaseUrl"]).toBe(
      "https://api.confluent.cloud",
    );
  });

  it("should set confluentCloudTelemetryBaseUrl from the telemetry block", () => {
    const manager = constructDirectClientManager(
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
    const manager = constructDirectClientManager(
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

  describe("constructor", () => {
    it("should store config and clientManagers as-is", () => {
      const cm = createMockInstance(DirectClientManager);
      const runtime = new ServerRuntime(config, { "test-conn": cm });
      expect(runtime.config).toBe(config);
      expect(runtime.clientManagers).toStrictEqual({ "test-conn": cm });
    });
  });

  describe("get clientManager()", () => {
    it("should return the sole client manager", () => {
      const cm = createMockInstance(DirectClientManager);
      const runtime = new ServerRuntime(config, { "test-conn": cm });
      expect(runtime.clientManager).toBe(cm);
    });

    it("should throw when clientManagers is empty", () => {
      const runtime = new ServerRuntime(config, {});
      expect(() => runtime.clientManager).toThrow(
        "ServerRuntime has no client managers",
      );
    });

    it("should throw when clientManagers has more than one entry", () => {
      const cm1 = createMockInstance(DirectClientManager);
      const cm2 = createMockInstance(DirectClientManager);
      const runtime = new ServerRuntime(config, { conn1: cm1, conn2: cm2 });
      expect(() => runtime.clientManager).toThrow(
        "ServerRuntime has multiple client managers",
      );
    });
  });

  describe("disconnectAll()", () => {
    it("should disconnect every configured client manager", async () => {
      const cm1 = createMockInstance(DirectClientManager);
      const cm2 = createMockInstance(DirectClientManager);
      const runtime = new ServerRuntime(config, { conn1: cm1, conn2: cm2 });

      await runtime.disconnectAll();

      expect(cm1.disconnect).toHaveBeenCalledOnce();
      expect(cm2.disconnect).toHaveBeenCalledOnce();
    });

    it("should await every disconnect even when one rejects, surfacing an AggregateError", async () => {
      const cm1 = createMockInstance(DirectClientManager);
      const cm2 = createMockInstance(DirectClientManager);
      const boom = new Error("conn1 disconnect failed");
      cm1.disconnect.mockRejectedValue(boom);
      cm2.disconnect.mockResolvedValue(undefined);
      const runtime = new ServerRuntime(config, { conn1: cm1, conn2: cm2 });

      let caught: unknown;
      await runtime.disconnectAll().catch((e) => {
        caught = e;
      });

      expect(cm1.disconnect).toHaveBeenCalledOnce();
      expect(cm2.disconnect).toHaveBeenCalledOnce();
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toEqual([boom]);
    });

    it("should aggregate every failure when multiple managers fail to disconnect", async () => {
      const cm1 = createMockInstance(DirectClientManager);
      const cm2 = createMockInstance(DirectClientManager);
      const cm3 = createMockInstance(DirectClientManager);
      const boom1 = new Error("conn1 disconnect failed");
      const boom2 = new Error("conn2 disconnect failed");
      cm1.disconnect.mockRejectedValue(boom1);
      cm2.disconnect.mockRejectedValue(boom2);
      cm3.disconnect.mockResolvedValue(undefined);
      const runtime = new ServerRuntime(config, {
        conn1: cm1,
        conn2: cm2,
        conn3: cm3,
      });

      let caught: unknown;
      await runtime.disconnectAll().catch((e) => {
        caught = e;
      });

      expect(cm3.disconnect).toHaveBeenCalledOnce();
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors).toEqual([boom1, boom2]);
    });
  });

  describe("isToolAllowed()", () => {
    it("should return true for any tool when no allow/block list was configured", () => {
      const runtime = new ServerRuntime(config, {});
      expect(runtime.isToolAllowed(ToolName.LIST_TOPICS)).toBe(true);
      expect(runtime.isToolAllowed(ToolName.CREATE_TOPICS)).toBe(true);
    });

    it("should return true for a tool present in the configured allow set", () => {
      const runtime = new ServerRuntime(
        config,
        {},
        undefined,
        new Set([ToolName.LIST_TOPICS]),
      );
      expect(runtime.isToolAllowed(ToolName.LIST_TOPICS)).toBe(true);
    });

    it("should return false for a tool absent from the configured allow set", () => {
      const runtime = new ServerRuntime(
        config,
        {},
        undefined,
        new Set([ToolName.LIST_TOPICS]),
      );
      expect(runtime.isToolAllowed(ToolName.CREATE_TOPICS)).toBe(false);
    });
  });

  describe("fromConfig()", () => {
    it("should thread allowedToolNames through so isToolAllowed gates accordingly", () => {
      const runtime = ServerRuntime.fromConfig(
        config,
        new Set([ToolName.LIST_TOPICS]),
      );
      expect(runtime.isToolAllowed(ToolName.LIST_TOPICS)).toBe(true);
      expect(runtime.isToolAllowed(ToolName.CREATE_TOPICS)).toBe(false);
    });

    it("should leave every tool allowed when called without an allow set", () => {
      const runtime = ServerRuntime.fromConfig(config);
      expect(runtime.isToolAllowed(ToolName.CREATE_TOPICS)).toBe(true);
    });

    it("should create a DirectClientManager for each connection", () => {
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
      const runtime = ServerRuntime.fromConfig(twoConnConfig);
      expect(Object.keys(runtime.clientManagers)).toStrictEqual([
        "conn1",
        "conn2",
      ]);
      expect(runtime.clientManagers["conn1"]).toBeInstanceOf(
        DirectClientManager,
      );
      expect(runtime.clientManagers["conn2"]).toBeInstanceOf(
        DirectClientManager,
      );
    });

    it("should store the config on the returned runtime", () => {
      const runtime = ServerRuntime.fromConfig(config);
      expect(runtime.config).toBe(config);
    });

    it("should leave oauthHolder undefined when the config has no ccloud-oauth", () => {
      const noOauthConfig = new MCPServerConfiguration({
        connections: {
          [DEFAULT_CONNECTION_NAME]: connWith({
            kafka: { bootstrap_servers: "broker:9092" },
          }),
        },
      });
      const runtime = ServerRuntime.fromConfig(noOauthConfig);
      expect(runtime.oauthHolder).toBeUndefined();
    });

    it("should construct an OAuthHolder when a connection has type 'oauth'", () => {
      const oauthConfig = new MCPServerConfiguration({
        connections: {
          [DEFAULT_CONNECTION_NAME]: { type: "oauth", ccloud_env: "devel" },
        },
      });

      const runtime = ServerRuntime.fromConfig(oauthConfig);

      expect(runtime.oauthHolder).toBeInstanceOf(OAuthHolder);
      expect(runtime.oauthHolder?.getControlPlaneToken()).toBeUndefined();
      expect(runtime.oauthHolder?.getDataPlaneToken()).toBeUndefined();
    });

    it("should construct an OAuthClientManager for an oauth connection", () => {
      const oauthConfig = new MCPServerConfiguration({
        connections: {
          [DEFAULT_CONNECTION_NAME]: { type: "oauth", ccloud_env: "stag" },
        },
      });

      const runtime = ServerRuntime.fromConfig(oauthConfig);

      expect(runtime.clientManagers[DEFAULT_CONNECTION_NAME]).toBeInstanceOf(
        OAuthClientManager,
      );
    });

    it("should construct per-connection manager types for a mixed direct + oauth config", () => {
      const mixedConfig = new MCPServerConfiguration({
        connections: {
          local: connWith({ kafka: { bootstrap_servers: "localhost:9092" } }),
          cloud: { type: "oauth", ccloud_env: "devel" },
        },
      });

      const runtime = ServerRuntime.fromConfig(mixedConfig);

      expect(runtime.clientManagers["local"]).toBeInstanceOf(
        DirectClientManager,
      );
      expect(runtime.clientManagers["cloud"]).toBeInstanceOf(
        OAuthClientManager,
      );
      expect(runtime.oauthHolder).toBeInstanceOf(OAuthHolder);
    });

    it("should throw when more than one OAuth connection is defined", () => {
      // Only one OAuth connection is supported (single shared CCloud identity);
      // fromConfig rejects a second one rather than silently dropping it.
      const multiOauthConfig = new MCPServerConfiguration({
        connections: {
          "oauth-1": { type: "oauth", ccloud_env: "devel" },
          "oauth-2": { type: "oauth", ccloud_env: "stag" },
        },
      });

      expect(() => ServerRuntime.fromConfig(multiOauthConfig)).toThrow(
        /Multiple OAuth connections defined/,
      );
    });
  });
});
