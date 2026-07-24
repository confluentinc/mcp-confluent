import {
  CONFLUENT_CLOUD_DEFAULT_ENDPOINT,
  type DirectConnectionConfig,
} from "@src/config/models.js";
import {
  constructDirectClientManager,
  DirectClientManager,
  type DirectClientManagerConfig,
} from "@src/confluent/direct-client-manager.js";
import type {
  ConfluentAuth,
  ConfluentEndpoints,
} from "@src/confluent/middleware.js";
import {
  getMockedAdmin,
  getMockedConsumer,
  getMockedProducer,
  mockKafkaConstructor,
} from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";

const apiKeyAuth: ConfluentAuth = { apiKey: "k", apiSecret: "s" };

function buildConfig(): DirectClientManagerConfig {
  const allUndefined: ConfluentEndpoints = {
    cloud: undefined,
    flink: undefined,
    schemaRegistry: undefined,
    kafka: undefined,
    telemetry: undefined,
  };
  return {
    kafka: { "client.id": "test" },
    endpoints: allUndefined,
    auth: {
      cloud: apiKeyAuth,
      tableflow: apiKeyAuth,
      flink: apiKeyAuth,
      schemaRegistry: apiKeyAuth,
      kafka: apiKeyAuth,
      telemetry: apiKeyAuth,
    },
  };
}

describe("direct-client-manager.ts", () => {
  describe("DirectClientManager", () => {
    describe("disconnect()", () => {
      it("should resolve without error on a fresh instance", async () => {
        const cm = new DirectClientManager(buildConfig());
        await expect(cm.disconnect()).resolves.toBeUndefined();
      });

      it("should disconnect admin and producer after both are initialized", async () => {
        const fakeAdmin = getMockedAdmin();
        fakeAdmin.connect.mockResolvedValue(undefined);
        fakeAdmin.disconnect.mockResolvedValue(undefined);
        const fakeProducer = getMockedProducer();
        fakeProducer.connect.mockResolvedValue(undefined);
        fakeProducer.disconnect.mockResolvedValue(undefined);
        mockKafkaConstructor({
          admin: vi.fn().mockReturnValue(fakeAdmin),
          producer: vi.fn().mockReturnValue(fakeProducer),
        });

        const cm = new DirectClientManager(buildConfig());
        await cm.getAdminClient();
        await cm.getProducer();
        await cm.disconnect();

        expect(fakeAdmin.disconnect).toHaveBeenCalledOnce();
        expect(fakeProducer.disconnect).toHaveBeenCalledOnce();
      });
    });

    describe("getKafkaClient()", () => {
      it("should return the Kafka instance and cache it across calls", () => {
        const fakeKafka = {
          admin: vi.fn(),
          producer: vi.fn(),
          consumer: vi.fn(),
        };
        mockKafkaConstructor(fakeKafka);

        const cm = new DirectClientManager(buildConfig());
        const first = cm.getKafkaClient();
        const second = cm.getKafkaClient();

        expect(first).toBe(fakeKafka);
        expect(second).toBe(fakeKafka);
      });
    });

    describe("getAdminClient()", () => {
      it("should connect and return the admin client", async () => {
        const fakeAdmin = getMockedAdmin();
        fakeAdmin.connect.mockResolvedValue(undefined);
        mockKafkaConstructor({ admin: vi.fn().mockReturnValue(fakeAdmin) });

        const cm = new DirectClientManager(buildConfig());
        const admin = await cm.getAdminClient();

        expect(admin).toBe(fakeAdmin);
        expect(fakeAdmin.connect).toHaveBeenCalledOnce();
      });

      it("should return the same admin instance on subsequent calls without reconnecting", async () => {
        const fakeAdmin = getMockedAdmin();
        fakeAdmin.connect.mockResolvedValue(undefined);
        const adminFn = vi.fn().mockReturnValue(fakeAdmin);
        mockKafkaConstructor({ admin: adminFn });

        const cm = new DirectClientManager(buildConfig());
        const first = await cm.getAdminClient();
        const second = await cm.getAdminClient();

        expect(first).toBe(second);
        expect(adminFn).toHaveBeenCalledOnce();
        expect(fakeAdmin.connect).toHaveBeenCalledOnce();
      });
    });

    describe("getProducer()", () => {
      it("should connect and return the producer", async () => {
        const fakeProducer = getMockedProducer();
        fakeProducer.connect.mockResolvedValue(undefined);
        mockKafkaConstructor({
          producer: vi.fn().mockReturnValue(fakeProducer),
        });

        const cm = new DirectClientManager(buildConfig());
        const producer = await cm.getProducer();

        expect(producer).toBe(fakeProducer);
        expect(fakeProducer.connect).toHaveBeenCalledOnce();
      });

      it("should return the same producer instance on subsequent calls without reconnecting", async () => {
        const fakeProducer = getMockedProducer();
        fakeProducer.connect.mockResolvedValue(undefined);
        const producerFn = vi.fn().mockReturnValue(fakeProducer);
        mockKafkaConstructor({ producer: producerFn });

        const cm = new DirectClientManager(buildConfig());
        const first = await cm.getProducer();
        const second = await cm.getProducer();

        expect(first).toBe(second);
        expect(producerFn).toHaveBeenCalledOnce();
        expect(fakeProducer.connect).toHaveBeenCalledOnce();
      });
    });

    describe("getKafkaAdminClient()", () => {
      it("should delegate to getAdminClient() ignoring clusterId and envId", async () => {
        const fakeAdmin = getMockedAdmin();
        fakeAdmin.connect.mockResolvedValue(undefined);
        mockKafkaConstructor({ admin: vi.fn().mockReturnValue(fakeAdmin) });

        const cm = new DirectClientManager(buildConfig());
        const admin = await cm.getKafkaAdminClient(
          "lkc-ignored",
          "env-ignored",
        );

        expect(admin).toBe(fakeAdmin);
      });
    });

    describe("getKafkaProducer()", () => {
      it("should delegate to getProducer() ignoring clusterId and envId", async () => {
        const fakeProducer = getMockedProducer();
        fakeProducer.connect.mockResolvedValue(undefined);
        mockKafkaConstructor({
          producer: vi.fn().mockReturnValue(fakeProducer),
        });

        const cm = new DirectClientManager(buildConfig());
        const producer = await cm.getKafkaProducer(
          "lkc-ignored",
          "env-ignored",
        );

        expect(producer).toBe(fakeProducer);
      });
    });

    describe("getConsumer()", () => {
      it("should build a consumer with groupId set to the sessionId suffix", async () => {
        const fakeConsumer = getMockedConsumer();
        const consumerFn = vi.fn().mockReturnValue(fakeConsumer);
        mockKafkaConstructor({ consumer: consumerFn });

        const cm = new DirectClientManager(buildConfig());
        const consumer = await cm.getConsumer("my-session");

        expect(consumer).toBe(fakeConsumer);
        expect(consumerFn.mock.calls[0]![0]).toMatchObject({
          "group.id": "mcp-confluent-my-session",
        });
      });

      it("should use the base group id when sessionId is omitted", async () => {
        const fakeConsumer = getMockedConsumer();
        const consumerFn = vi.fn().mockReturnValue(fakeConsumer);
        mockKafkaConstructor({ consumer: consumerFn });

        const cm = new DirectClientManager(buildConfig());
        await cm.getConsumer();

        expect(consumerFn.mock.calls[0]![0]).toMatchObject({
          "group.id": "mcp-confluent",
        });
      });
    });

    describe("buildKafkaConsumer()", () => {
      it("should default auto.offset.reset to 'earliest' when offsetReset is omitted", async () => {
        const fakeConsumer = getMockedConsumer();
        const consumerFn = vi.fn().mockReturnValue(fakeConsumer);
        mockKafkaConstructor({ consumer: consumerFn });

        const cm = new DirectClientManager(buildConfig());
        await cm.buildKafkaConsumer();

        expect(consumerFn).toHaveBeenCalledOnce();
        expect(consumerFn.mock.calls[0]![0]).toMatchObject({
          "auto.offset.reset": "earliest",
        });
      });

      it.each(["earliest", "latest"] as const)(
        "should propagate offsetReset=%s to auto.offset.reset",
        async (offsetReset) => {
          const fakeConsumer = getMockedConsumer();
          const consumerFn = vi.fn().mockReturnValue(fakeConsumer);
          mockKafkaConstructor({ consumer: consumerFn });

          const cm = new DirectClientManager(buildConfig());
          await cm.buildKafkaConsumer({ offsetReset });

          expect(consumerFn).toHaveBeenCalledOnce();
          expect(consumerFn.mock.calls[0]![0]).toMatchObject({
            "auto.offset.reset": offsetReset,
          });
        },
      );

      it("should append opts.groupId as a suffix to the configured base group.id (preserving sessionId behavior)", async () => {
        const fakeConsumer = getMockedConsumer();
        const consumerFn = vi.fn().mockReturnValue(fakeConsumer);
        mockKafkaConstructor({ consumer: consumerFn });

        const cm = new DirectClientManager(buildConfig());
        await cm.buildKafkaConsumer({ groupId: "session-42" });

        expect(consumerFn).toHaveBeenCalledOnce();
        expect(consumerFn.mock.calls[0]![0]).toMatchObject({
          "group.id": "mcp-confluent-session-42",
        });
      });
    });
  });

  describe("constructDirectClientManager()", () => {
    it("should build full SASL config when kafka.auth and bootstrap_servers are present", () => {
      const conn: DirectConnectionConfig = {
        type: "direct",
        kafka: {
          bootstrap_servers: "broker:9092",
          auth: { type: "api_key", key: "k1", secret: "s1" },
        },
      };

      const cm = constructDirectClientManager(conn);

      expect(cm["kafkaConfig"]).toEqual({
        "client.id": "mcp-confluent",
        "bootstrap.servers": "broker:9092",
        "security.protocol": "sasl_ssl",
        "sasl.mechanisms": "PLAIN",
        "sasl.username": "k1",
        "sasl.password": "s1",
      });
    });

    it("should omit SASL fields when kafka.auth is absent", () => {
      const conn: DirectConnectionConfig = {
        type: "direct",
        kafka: { bootstrap_servers: "broker:9092" },
      };

      const cm = constructDirectClientManager(conn);

      expect(cm["kafkaConfig"]).toEqual({
        "client.id": "mcp-confluent",
        "bootstrap.servers": "broker:9092",
      });
    });

    it("should omit bootstrap.servers when kafka.bootstrap_servers is absent", () => {
      const conn: DirectConnectionConfig = {
        type: "direct",
        kafka: { auth: { type: "api_key", key: "k1", secret: "s1" } },
      };

      const cm = constructDirectClientManager(conn);

      expect(cm["kafkaConfig"]).toEqual({
        "client.id": "mcp-confluent",
        "security.protocol": "sasl_ssl",
        "sasl.mechanisms": "PLAIN",
        "sasl.username": "k1",
        "sasl.password": "s1",
      });
    });

    it("should spread kafka.extra_properties into the kafka config", () => {
      const conn: DirectConnectionConfig = {
        type: "direct",
        kafka: {
          extra_properties: {
            "socket.timeout.ms": "30000",
            debug: "broker",
          },
        },
      };

      const cm = constructDirectClientManager(conn);

      expect(cm["kafkaConfig"]).toEqual({
        "client.id": "mcp-confluent",
        "socket.timeout.ms": "30000",
        debug: "broker",
      });
    });

    it("should use confluent_cloud.endpoint when provided", () => {
      const conn: DirectConnectionConfig = {
        type: "direct",
        confluent_cloud: {
          endpoint: "https://my.custom.confluent.cloud",
          auth: { type: "api_key", key: "k", secret: "s" },
        },
      };

      const cm = constructDirectClientManager(conn);

      expect(cm["confluentCloudBaseUrl"]).toBe(
        "https://my.custom.confluent.cloud",
      );
    });

    it("should fall back to CONFLUENT_CLOUD_DEFAULT_ENDPOINT when confluent_cloud is absent", () => {
      const conn: DirectConnectionConfig = { type: "direct" };

      const cm = constructDirectClientManager(conn);

      expect(cm["confluentCloudBaseUrl"]).toBe(
        CONFLUENT_CLOUD_DEFAULT_ENDPOINT,
      );
    });

    it("should return a DirectClientManager instance", () => {
      const conn: DirectConnectionConfig = {
        type: "direct",
        kafka: { bootstrap_servers: "broker:9092" },
      };

      const cm = constructDirectClientManager(conn);

      expect(cm).toBeInstanceOf(DirectClientManager);
    });

    it("should omit all kafka properties when there is no kafka block", () => {
      const conn: DirectConnectionConfig = {
        type: "direct",
        confluent_cloud: {
          endpoint: "https://api.confluent.cloud",
          auth: { type: "api_key", key: "k", secret: "s" },
        },
      };

      const cm = constructDirectClientManager(conn);

      expect(cm["kafkaConfig"]).toEqual({ "client.id": "mcp-confluent" });
    });

    it("should set confluentCloudTelemetryBaseUrl from the telemetry block", () => {
      const conn: DirectConnectionConfig = {
        type: "direct",
        telemetry: {
          endpoint: "https://my.telemetry.api",
          auth: { type: "api_key", key: "k", secret: "s" },
        },
      };

      const cm = constructDirectClientManager(conn);

      expect(cm["confluentCloudTelemetryBaseUrl"]).toBe(
        "https://my.telemetry.api",
      );
    });

    it("should leave confluentCloudTelemetryBaseUrl undefined when there is no telemetry block", () => {
      const conn: DirectConnectionConfig = { type: "direct" };

      const cm = constructDirectClientManager(conn);

      expect(cm["confluentCloudTelemetryBaseUrl"]).toBeUndefined();
    });
  });
});
