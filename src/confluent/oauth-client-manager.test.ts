import type { KafkaJS } from "@confluentinc/kafka-javascript";
import * as nodeDeps from "@src/confluent/node-deps.js";
import { OAuthClientManager } from "@src/confluent/oauth-client-manager.js";
import * as resolvers from "@src/confluent/oauth-resource-resolvers.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";

describe("oauth-client-manager.ts", () => {
  describe("OAuthClientManager", () => {
    function buildManager(): OAuthClientManager {
      const holder = createMockInstance(OAuthHolder);
      // Provide a non-empty data-plane token so the post-gate guard in
      // requireDataPlaneToken passes (the gate would have populated it
      // before any tool call reaches this manager in production).
      holder.getDataPlaneToken.mockReturnValue("dpat");
      return new OAuthClientManager(holder, "devel");
    }

    describe("getKafkaAdminClient()", () => {
      it("should throw when cluster_id is omitted under OAuth", async () => {
        const manager = buildManager();
        await expect(
          manager.getKafkaAdminClient(undefined, "env-1"),
        ).rejects.toThrow(
          "OAuth client construction requires a cluster id and environment id",
        );
      });

      it("should throw when environment_id is omitted under OAuth", async () => {
        const manager = buildManager();
        await expect(
          manager.getKafkaAdminClient("lkc-1", undefined),
        ).rejects.toThrow(
          "OAuth client construction requires a cluster id and environment id",
        );
      });

      it("should build a fresh Kafka instance on each call (no caching)", async () => {
        vi.spyOn(resolvers, "resolveKafkaBootstrap").mockResolvedValue(
          "broker:9092",
        );
        const fakeAdmin = {
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          // listTopics is invoked once per call as a metadata warmup —
          // see comment in OAuthClientManager.getKafkaAdminClient.
          listTopics: vi.fn().mockResolvedValue([]),
        };
        const fakeKafka = { admin: () => fakeAdmin };
        const kafkaSpy = vi
          .spyOn(nodeDeps.kafkaDeps, "Kafka")
          .mockImplementation(function () {
            return fakeKafka as unknown as KafkaJS.Kafka;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);

        const manager = buildManager();
        await manager.getKafkaAdminClient("lkc-1", "env-1");
        await manager.getKafkaAdminClient("lkc-1", "env-1");

        expect(kafkaSpy).toHaveBeenCalledTimes(2);
      });

      it("should pass librdkafka `debug` contexts through when kafka_debug is configured on the OAuth connection", async () => {
        vi.spyOn(resolvers, "resolveKafkaBootstrap").mockResolvedValue(
          "broker:9092",
        );
        const fakeAdmin = {
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          listTopics: vi.fn().mockResolvedValue([]),
        };
        let capturedConfig: Record<string, unknown> | undefined;
        vi.spyOn(nodeDeps.kafkaDeps, "Kafka").mockImplementation(function (
          config: Record<string, unknown>,
        ) {
          capturedConfig = config;
          return { admin: () => fakeAdmin } as unknown as KafkaJS.Kafka;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        const holder = createMockInstance(OAuthHolder);
        holder.getDataPlaneToken.mockReturnValue("dpat");
        const manager = new OAuthClientManager(
          holder,
          "devel",
          "security,broker,protocol",
        );
        await manager.getKafkaAdminClient("lkc-1", "env-1");

        expect(capturedConfig).toBeDefined();
        expect(capturedConfig!["debug"]).toBe("security,broker,protocol");
      });

      it("should omit `debug` from the rdkafka config when kafka_debug is undefined", async () => {
        vi.spyOn(resolvers, "resolveKafkaBootstrap").mockResolvedValue(
          "broker:9092",
        );
        const fakeAdmin = {
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          listTopics: vi.fn().mockResolvedValue([]),
        };
        let capturedConfig: Record<string, unknown> | undefined;
        vi.spyOn(nodeDeps.kafkaDeps, "Kafka").mockImplementation(function (
          config: Record<string, unknown>,
        ) {
          capturedConfig = config;
          return { admin: () => fakeAdmin } as unknown as KafkaJS.Kafka;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        const manager = buildManager();
        await manager.getKafkaAdminClient("lkc-1", "env-1");

        expect(capturedConfig).toBeDefined();
        // The key must be absent — not present-but-undefined — so the
        // rdkafka client never receives a stray `debug` property.
        expect(Object.hasOwn(capturedConfig!, "debug")).toBe(false);
      });

      it("should configure KafkaJS.Kafka with librdkafka-native SASL keys, not the kafkaJS-compat async provider", async () => {
        // Regression guard: re-introducing `kafkaJS.sasl.oauthBearerProvider`
        // would resurrect the SASL race that previously required a warmup
        // workaround. The librdkafka-native top-level keys + a synchronous
        // `oauthbearer_token_refresh_cb` is the only configuration this
        // codebase uses for OAUTHBEARER.
        vi.spyOn(resolvers, "resolveKafkaBootstrap").mockResolvedValue(
          "broker:9092",
        );
        const fakeAdmin = {
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
          // listTopics is invoked once per call as a metadata warmup —
          // see comment in OAuthClientManager.getKafkaAdminClient.
          listTopics: vi.fn().mockResolvedValue([]),
        };
        let capturedConfig: Record<string, unknown> | undefined;
        vi.spyOn(nodeDeps.kafkaDeps, "Kafka").mockImplementation(function (
          config: Record<string, unknown>,
        ) {
          capturedConfig = config;
          return { admin: () => fakeAdmin } as unknown as KafkaJS.Kafka;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        const manager = buildManager();
        await manager.getKafkaAdminClient("lkc-1", "env-1");

        expect(capturedConfig).toBeDefined();
        expect(capturedConfig!["security.protocol"]).toBe("sasl_ssl");
        expect(capturedConfig!["sasl.mechanisms"]).toBe("OAUTHBEARER");
        expect(typeof capturedConfig!["oauthbearer_token_refresh_cb"]).toBe(
          "function",
        );
        // The kafkaJS-compat async provider must NOT be present.
        const kafkaJsBlock = capturedConfig!["kafkaJS"] as
          | Record<string, unknown>
          | undefined;
        expect(kafkaJsBlock?.["sasl"]).toBeUndefined();
      });
    });

    describe("getKafkaProducer()", () => {
      it("should throw when cluster_id is omitted under OAuth", async () => {
        const manager = buildManager();
        await expect(
          manager.getKafkaProducer(undefined, "env-1"),
        ).rejects.toThrow(
          "OAuth client construction requires a cluster id and environment id",
        );
      });

      it("should throw when environment_id is omitted under OAuth", async () => {
        const manager = buildManager();
        await expect(
          manager.getKafkaProducer("lkc-1", undefined),
        ).rejects.toThrow(
          "OAuth client construction requires a cluster id and environment id",
        );
      });

      it("should build, connect, and return a producer per call", async () => {
        vi.spyOn(resolvers, "resolveKafkaBootstrap").mockResolvedValue(
          "broker:9092",
        );
        const fakeProducer = {
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
        };
        const fakeKafka = { producer: () => fakeProducer };
        vi.spyOn(nodeDeps.kafkaDeps, "Kafka").mockImplementation(function () {
          return fakeKafka as unknown as KafkaJS.Kafka;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        const manager = buildManager();
        const producer = await manager.getKafkaProducer("lkc-1", "env-1");

        expect(producer).toBe(fakeProducer);
        expect(fakeProducer.connect).toHaveBeenCalledOnce();
      });
    });

    describe("buildKafkaConsumer()", () => {
      it("should throw when cluster_id is omitted under OAuth", async () => {
        const manager = buildManager();
        await expect(
          manager.buildKafkaConsumer(undefined, "env-1"),
        ).rejects.toThrow(
          "OAuth client construction requires a cluster id and environment id",
        );
      });

      it("should throw when environment_id is omitted under OAuth", async () => {
        const manager = buildManager();
        await expect(
          manager.buildKafkaConsumer("lkc-1", undefined),
        ).rejects.toThrow(
          "OAuth client construction requires a cluster id and environment id",
        );
      });

      it("should build a consumer with the default groupId 'mcp-confluent' when none is supplied", async () => {
        vi.spyOn(resolvers, "resolveKafkaBootstrap").mockResolvedValue(
          "broker:9092",
        );
        const fakeConsumer = { connect: vi.fn(), disconnect: vi.fn() };
        let consumerOpts:
          | {
              kafkaJS?: {
                groupId?: string;
                autoCommit?: boolean;
                fromBeginning?: boolean;
              };
            }
          | undefined;
        const fakeKafka = {
          consumer: (opts: typeof consumerOpts) => {
            consumerOpts = opts;
            return fakeConsumer;
          },
        };
        vi.spyOn(nodeDeps.kafkaDeps, "Kafka").mockImplementation(function () {
          return fakeKafka as unknown as KafkaJS.Kafka;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        const manager = buildManager();
        await manager.buildKafkaConsumer("lkc-1", "env-1");

        expect(consumerOpts?.kafkaJS).toMatchObject({
          groupId: "mcp-confluent",
          autoCommit: false,
          fromBeginning: true,
        });
      });

      it("should pass an explicit groupId through to the consumer config", async () => {
        vi.spyOn(resolvers, "resolveKafkaBootstrap").mockResolvedValue(
          "broker:9092",
        );
        const fakeConsumer = { connect: vi.fn(), disconnect: vi.fn() };
        let consumerOpts: { kafkaJS?: { groupId?: string } } | undefined;
        const fakeKafka = {
          consumer: (opts: typeof consumerOpts) => {
            consumerOpts = opts;
            return fakeConsumer;
          },
        };
        vi.spyOn(nodeDeps.kafkaDeps, "Kafka").mockImplementation(function () {
          return fakeKafka as unknown as KafkaJS.Kafka;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        const manager = buildManager();
        await manager.buildKafkaConsumer("lkc-1", "env-1", "session-42");

        expect(consumerOpts?.kafkaJS?.groupId).toBe("session-42");
      });
    });

    describe("getSchemaRegistrySdkClient()", () => {
      it("should throw when envId is omitted under OAuth", async () => {
        const manager = buildManager();
        await expect(
          manager.getSchemaRegistrySdkClient(undefined),
        ).rejects.toThrow(
          /environment_id is required under OAuth for Schema Registry access/,
        );
      });

      it("should throw when DPAT is unavailable", async () => {
        // Symmetric with the Kafka-side guard — prevents constructing an SR
        // SDK client with `Authorization: Bearer ` (empty) baked into axios
        // defaults if the holder has been cleared or hit a non-transient
        // refresh failure between the gate check and this method.
        const holder = createMockInstance(OAuthHolder);
        holder.getDataPlaneToken.mockReturnValue(undefined);
        const manager = new OAuthClientManager(holder, "devel");

        await expect(
          manager.getSchemaRegistrySdkClient("env-1"),
        ).rejects.toThrow("No data-plane token available");
      });

      it("should resolve lsrc from envId and build the SDK client against the resolved endpoint", async () => {
        const resolveSole = vi
          .spyOn(resolvers, "resolveSchemaRegistryClusterId")
          .mockResolvedValue("lsrc-auto");
        const resolveEndpoint = vi
          .spyOn(resolvers, "resolveSchemaRegistryEndpoint")
          .mockResolvedValue("https://psrc-auto.us-east-1.aws.confluent.cloud");

        const manager = buildManager();
        const client = await manager.getSchemaRegistrySdkClient("env-1");

        expect(client).toBeDefined();
        expect(resolveSole).toHaveBeenCalledWith(expect.anything(), "env-1");
        expect(resolveEndpoint).toHaveBeenCalledWith(
          expect.anything(),
          "lsrc-auto",
          "env-1",
        );
      });
    });

    describe("getConfluentCloudKafkaRestClient()", () => {
      it("should reject when cluster_id is omitted under OAuth", async () => {
        const manager = buildManager();
        await expect(
          manager.getConfluentCloudKafkaRestClient(undefined, "env-1"),
        ).rejects.toThrow(
          "OAuth client construction requires a cluster id and environment id",
        );
      });

      it("should reject when environment_id is omitted under OAuth", async () => {
        const manager = buildManager();
        await expect(
          manager.getConfluentCloudKafkaRestClient("lkc-1", undefined),
        ).rejects.toThrow(
          "OAuth client construction requires a cluster id and environment id",
        );
      });

      it("should build a fresh REST client per call against the resolved http_endpoint", async () => {
        vi.spyOn(resolvers, "resolveKafkaRestEndpoint").mockResolvedValue(
          "https://pkc-xxxxx.us-east-1.aws.confluent.cloud:443",
        );

        const manager = buildManager();
        const c1 = await manager.getConfluentCloudKafkaRestClient(
          "lkc-1",
          "env-1",
        );
        const c2 = await manager.getConfluentCloudKafkaRestClient(
          "lkc-1",
          "env-1",
        );

        expect(c1).toBeDefined();
        expect(c2).toBeDefined();
        expect(c1).not.toBe(c2);
        expect(resolvers.resolveKafkaRestEndpoint).toHaveBeenCalledTimes(2);
        expect(resolvers.resolveKafkaRestEndpoint).toHaveBeenCalledWith(
          expect.anything(),
          "lkc-1",
          "env-1",
        );
      });
    });

    describe("disconnect()", () => {
      it("should be a no-op (no caches to drain — clients are caller-owned)", async () => {
        const manager = buildManager();
        await expect(manager.disconnect()).resolves.toBeUndefined();
      });
    });
  });
});
