import { type DirectConnectionConfig } from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import {
  buildAuthConfigForConnection,
  constructClientManagerForConnection,
  DefaultClientManager,
} from "@src/confluent/client-manager.js";
import { ConfluentAuth } from "@src/confluent/middleware.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";

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

describe("buildAuthConfigForConnection()", () => {
  // Connection fixture with every surface wired so each surface's auth slice
  // resolves with both an api_key block (for the fallback test) and a
  // realistic shape. Pure-function tests — no client constructed.
  const connFull = connWith({
    kafka: {
      bootstrap_servers: "broker:9092",
      rest_endpoint: "https://kafka-rest.example.com",
      auth: { type: "api_key", key: "k", secret: "s" },
    },
    schema_registry: {
      endpoint: "https://sr.example.com",
      auth: { type: "api_key", key: "k", secret: "s" },
    },
    flink: {
      endpoint: "https://flink.example.com",
      auth: { type: "api_key", key: "k", secret: "s" },
      environment_id: "env-1",
      organization_id: "org-1",
      compute_pool_id: "lfcp-1",
    },
    confluent_cloud: {
      endpoint: "https://cp.example.com",
      auth: { type: "api_key", key: "k", secret: "s" },
    },
    tableflow: {
      auth: { type: "api_key", key: "k", secret: "s" },
    },
    telemetry: {
      endpoint: "https://telemetry.example.com",
      auth: { type: "api_key", key: "k", secret: "s" },
    },
  });

  // Narrows a ConfluentAuth to its oauth variant or fails the test loudly.
  // Lets each test call .getToken() without re-narrowing in every body.
  function expectOAuth(auth: ConfluentAuth): {
    type: "oauth";
    getToken: () => string | undefined;
  } {
    if (auth.type !== "oauth") {
      throw new Error(`expected oauth variant, got ${JSON.stringify(auth)}`);
    }
    return auth;
  }

  it("should wire the CP plane closure on cloud, tableflow, and telemetry when oauthHolder is supplied", () => {
    const cpSpy = vi.fn(() => "cp-token");
    const dpSpy = vi.fn(() => "dp-token");
    const fakeHolder = {
      getControlPlaneToken: cpSpy,
      getDataPlaneToken: dpSpy,
    } as unknown as OAuthHolder;

    const auth = buildAuthConfigForConnection(connFull, fakeHolder);

    expect(expectOAuth(auth.cloud).getToken()).toBe("cp-token");
    expect(expectOAuth(auth.tableflow).getToken()).toBe("cp-token");
    expect(expectOAuth(auth.telemetry).getToken()).toBe("cp-token");
    expect(cpSpy).toHaveBeenCalledTimes(3);
    expect(dpSpy).not.toHaveBeenCalled();
  });

  it("should wire the DP plane closure on flink, schemaRegistry, and kafka when oauthHolder is supplied", () => {
    const cpSpy = vi.fn(() => "cp-token");
    const dpSpy = vi.fn(() => "dp-token");
    const fakeHolder = {
      getControlPlaneToken: cpSpy,
      getDataPlaneToken: dpSpy,
    } as unknown as OAuthHolder;

    const auth = buildAuthConfigForConnection(connFull, fakeHolder);

    expect(expectOAuth(auth.flink).getToken()).toBe("dp-token");
    expect(expectOAuth(auth.schemaRegistry).getToken()).toBe("dp-token");
    expect(expectOAuth(auth.kafka).getToken()).toBe("dp-token");
    expect(dpSpy).toHaveBeenCalledTimes(3);
    expect(cpSpy).not.toHaveBeenCalled();
  });

  it("should fall back to api_key shape on every surface when oauthHolder is omitted", () => {
    const auth = buildAuthConfigForConnection(connFull);

    const expected = { apiKey: "k", apiSecret: "s" };
    expect(auth.cloud).toEqual(expected);
    expect(auth.tableflow).toEqual(expected);
    expect(auth.telemetry).toEqual(expected);
    expect(auth.flink).toEqual(expected);
    expect(auth.schemaRegistry).toEqual(expected);
    expect(auth.kafka).toEqual(expected);
  });

  it("should leave api_key fields undefined when the connection block is missing entirely", () => {
    const sparseConn = connWith({
      kafka: { bootstrap_servers: "broker:9092" },
    });

    const auth = buildAuthConfigForConnection(sparseConn);

    // No confluent_cloud / tableflow / telemetry / flink / schema_registry blocks
    // → each surface falls back to apiKey/apiSecret = undefined. The kafka
    // block is present but has no `auth` field, so the same fallback applies.
    expect(auth.cloud).toEqual({ apiKey: undefined, apiSecret: undefined });
    expect(auth.tableflow).toEqual({ apiKey: undefined, apiSecret: undefined });
    expect(auth.telemetry).toEqual({ apiKey: undefined, apiSecret: undefined });
    expect(auth.flink).toEqual({ apiKey: undefined, apiSecret: undefined });
    expect(auth.schemaRegistry).toEqual({
      apiKey: undefined,
      apiSecret: undefined,
    });
    expect(auth.kafka).toEqual({ apiKey: undefined, apiSecret: undefined });
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
      const cm = createMockInstance(DefaultClientManager);
      const runtime = new ServerRuntime(config, { "test-conn": cm });
      expect(runtime.config).toBe(config);
      expect(runtime.clientManagers).toStrictEqual({ "test-conn": cm });
    });
  });

  describe("get clientManager()", () => {
    it("should return the sole client manager", () => {
      const cm = createMockInstance(DefaultClientManager);
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
      const cm1 = createMockInstance(DefaultClientManager);
      const cm2 = createMockInstance(DefaultClientManager);
      const runtime = new ServerRuntime(config, { conn1: cm1, conn2: cm2 });
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
      const runtime = ServerRuntime.fromConfig(twoConnConfig);
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
      const fakeHolder = {} as OAuthHolder;
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
  });
});
