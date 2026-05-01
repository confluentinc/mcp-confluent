import { type ClientManagerConfig } from "@src/confluent/client-manager.js";
import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import type {
  ConfluentAuth,
  ConfluentEndpoints,
} from "@src/confluent/middleware.js";
import { describe, expect, it } from "vitest";

const apiKeyAuth: ConfluentAuth = { apiKey: "k", apiSecret: "s" };

function buildConfig(): ClientManagerConfig {
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
  });
});
