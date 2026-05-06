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
      // OAuthHolder has a private constructor (factory pattern via .start()),
      // so we widen the constructor signature for createMockInstance which
      // expects an externally-callable ctor.
      const holder = createMockInstance(
        OAuthHolder as unknown as new (...args: never[]) => OAuthHolder,
      );
      // OAuthHolder.bootstrapPromise is an instance field set in the real
      // constructor, which createMockInstance bypasses. Define it here so
      // the OAuth manager's `await this.holder.bootstrapPromise` resolves.
      Object.defineProperty(holder, "bootstrapPromise", {
        value: Promise.resolve(),
        writable: true,
        configurable: true,
      });
      // Provide a non-empty data-plane token so buildOAuthKafkaClient passes
      // its post-bootstrap guard.
      holder.getDataPlaneToken.mockReturnValue("dpat");
      return new OAuthClientManager(holder as unknown as OAuthHolder, "devel");
    }

    describe("getKafkaAdminClient()", () => {
      it("should throw when cluster_id is omitted under OAuth", async () => {
        const manager = buildManager();
        await expect(
          manager.getKafkaAdminClient(undefined, "env-1"),
        ).rejects.toThrow(
          "cluster_id and environment_id are required under --oauth",
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

    describe("disconnect()", () => {
      it("should be a no-op (no caches to drain — clients are caller-owned)", async () => {
        const manager = buildManager();
        await expect(manager.disconnect()).resolves.toBeUndefined();
      });
    });
  });
});
