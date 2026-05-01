import { type DirectConnectionConfig } from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import {
  constructClientManagerForConnection,
  DirectClientManager,
} from "@src/confluent/direct-client-manager.js";
import { OAuthClientManager } from "@src/confluent/oauth-client-manager.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";

function fakeOAuthHolder(): OAuthHolder {
  return {
    getControlPlaneToken: () => "cp-token",
    getDataPlaneToken: () => "dp-token",
  } as unknown as OAuthHolder;
}

function connWith(
  fields: Omit<DirectConnectionConfig, "type">,
): DirectConnectionConfig {
  return { type: "direct", ...fields };
}

describe("constructClientManagerForConnection()", () => {
  it("should return a DirectClientManager instance", () => {
    const manager = constructClientManagerForConnection(
      connWith({ kafka: { bootstrap_servers: "broker:9092" } }),
    );
    expect(manager).toBeInstanceOf(DirectClientManager);
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

  describe("fromConfig()", () => {
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
          "env-connection": connWith({
            kafka: { bootstrap_servers: "broker:9092" },
          }),
        },
      });
      const runtime = ServerRuntime.fromConfig(noOauthConfig);
      expect(runtime.oauthHolder).toBeUndefined();
    });

    it("should call OAuthHolder.start and expose oauthHolder when the config has ccloud-oauth", () => {
      const fakeHolder = fakeOAuthHolder();
      const startSpy = vi
        .spyOn(OAuthHolder, "start")
        .mockReturnValue(fakeHolder);

      const oauthConfig = new MCPServerConfiguration({
        connections: {
          "env-connection": connWith({
            kafka: { bootstrap_servers: "broker:9092" },
          }),
        },
        ccloudOAuth: { type: "ccloud_oauth", env: "devel" },
      });

      const runtime = ServerRuntime.fromConfig(oauthConfig);

      expect(startSpy).toHaveBeenCalledWith("devel");
      expect(runtime.oauthHolder).toBe(fakeHolder);
    });

    it("should construct OAuthClientManager instances for every connection when ccloud-oauth is set", () => {
      vi.spyOn(OAuthHolder, "start").mockReturnValue(fakeOAuthHolder());
      const oauthConfig = new MCPServerConfiguration({
        connections: {
          "env-connection": connWith({
            kafka: { bootstrap_servers: "broker:9092" },
          }),
        },
        ccloudOAuth: { type: "ccloud_oauth", env: "stag" },
      });

      const runtime = ServerRuntime.fromConfig(oauthConfig);

      expect(runtime.clientManagers["env-connection"]).toBeInstanceOf(
        OAuthClientManager,
      );
    });
  });
});
