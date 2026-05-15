import {
  DirectClientManager,
  type DirectClientManagerConfig,
} from "@src/confluent/direct-client-manager.js";
import type {
  ConfluentAuth,
  ConfluentEndpoints,
} from "@src/confluent/middleware.js";
import { getMockedConsumer, mockKafkaConstructor } from "@tests/stubs/index.js";
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

      it.each([
        ["earliest", "earliest"],
        ["latest", "latest"],
        // "none" is the tool-facing alias; librdkafka has no "none" — its
        // fail-rather-than-auto-pick value is "error".
        ["none", "error"],
      ] as const)(
        "should propagate offsetReset=%s as native auto.offset.reset=%s",
        async (offsetReset, expectedReset) => {
          const fakeConsumer = getMockedConsumer();
          const consumerFn = vi.fn().mockReturnValue(fakeConsumer);
          mockKafkaConstructor({ consumer: consumerFn });

          const cm = new DirectClientManager(buildConfig());
          await cm.buildKafkaConsumer({ offsetReset });

          expect(consumerFn).toHaveBeenCalledOnce();
          expect(consumerFn.mock.calls[0]![0]).toMatchObject({
            "auto.offset.reset": expectedReset,
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
});
