import { type DirectConnectionConfig } from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import {
  constructClientManagerForConnection,
  DefaultClientManager,
} from "@src/confluent/client-manager.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import { paths } from "@src/confluent/openapi-schema.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { Client } from "openapi-fetch";
import {
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

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

  describe("with oauthHolder", () => {
    let cpSpy: ReturnType<typeof vi.fn>;
    let dpSpy: ReturnType<typeof vi.fn>;
    let fakeHolder: OAuthHolder;
    let fetchSpy: MockInstance<typeof globalThis.fetch>;

    // Connection fixture with every surface wired so each lazy REST client
    // can be initialized for these tests. Endpoints are placeholder hosts;
    // openapi-fetch hands the request to globalThis.fetch (which we spy on)
    // before any network round-trip happens.
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

    beforeEach(() => {
      cpSpy = vi.fn(() => "cp-token");
      dpSpy = vi.fn(() => "dp-token");
      fakeHolder = {
        getControlPlaneToken: cpSpy,
        getDataPlaneToken: dpSpy,
      } as unknown as OAuthHolder;
      fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("{}"));
    });

    // Exercises the openapi-fetch client with an arbitrary path and returns
    // the Request that the bearer middleware mutated before
    // globalThis.fetch was called. Cast to `any` because the openapi-fetch
    // typing constrains paths to keys of `paths` and we don't care which
    // path runs — any path traverses the middleware identically.
    async function fireRequest(
      client: Client<paths, `${string}/${string}`>,
    ): Promise<Request> {
      fetchSpy.mockClear();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (client as any).GET("/test-path");
      expect(fetchSpy).toHaveBeenCalledOnce();
      return fetchSpy.mock.calls[0]![0] as Request;
    }

    it("should attach Bearer <CP token> on the Confluent Cloud REST client", async () => {
      const manager = constructClientManagerForConnection(connFull, fakeHolder);
      const request = await fireRequest(manager.getConfluentCloudRestClient());
      expect(request.headers.get("Authorization")).toBe("Bearer cp-token");
      expect(cpSpy).toHaveBeenCalled();
      expect(dpSpy).not.toHaveBeenCalled();
    });

    it("should attach Bearer <CP token> on the Tableflow REST client", async () => {
      const manager = constructClientManagerForConnection(connFull, fakeHolder);
      const request = await fireRequest(
        manager.getConfluentCloudTableflowRestClient(),
      );
      expect(request.headers.get("Authorization")).toBe("Bearer cp-token");
      expect(cpSpy).toHaveBeenCalled();
      expect(dpSpy).not.toHaveBeenCalled();
    });

    it("should attach Bearer <CP token> on the Telemetry REST client", async () => {
      const manager = constructClientManagerForConnection(connFull, fakeHolder);
      const request = await fireRequest(
        manager.getConfluentCloudTelemetryRestClient(),
      );
      expect(request.headers.get("Authorization")).toBe("Bearer cp-token");
      expect(cpSpy).toHaveBeenCalled();
      expect(dpSpy).not.toHaveBeenCalled();
    });

    it("should attach Bearer <DP token> on the Flink REST client", async () => {
      const manager = constructClientManagerForConnection(connFull, fakeHolder);
      const request = await fireRequest(
        manager.getConfluentCloudFlinkRestClient(),
      );
      expect(request.headers.get("Authorization")).toBe("Bearer dp-token");
      expect(dpSpy).toHaveBeenCalled();
      expect(cpSpy).not.toHaveBeenCalled();
    });

    it("should attach Bearer <DP token> on the Schema Registry REST client", async () => {
      const manager = constructClientManagerForConnection(connFull, fakeHolder);
      const request = await fireRequest(
        manager.getConfluentCloudSchemaRegistryRestClient(),
      );
      expect(request.headers.get("Authorization")).toBe("Bearer dp-token");
      expect(dpSpy).toHaveBeenCalled();
      expect(cpSpy).not.toHaveBeenCalled();
    });

    it("should attach Bearer <DP token> on the Kafka REST client", async () => {
      const manager = constructClientManagerForConnection(connFull, fakeHolder);
      const request = await fireRequest(
        manager.getConfluentCloudKafkaRestClient(),
      );
      expect(request.headers.get("Authorization")).toBe("Bearer dp-token");
      expect(dpSpy).toHaveBeenCalled();
      expect(cpSpy).not.toHaveBeenCalled();
    });

    it("should fall back to api_key Basic auth on every surface when oauthHolder is omitted", async () => {
      const manager = constructClientManagerForConnection(connFull);
      const request = await fireRequest(manager.getConfluentCloudRestClient());
      expect(request.headers.get("Authorization")).toMatch(/^Basic /);
      expect(cpSpy).not.toHaveBeenCalled();
      expect(dpSpy).not.toHaveBeenCalled();
    });
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
