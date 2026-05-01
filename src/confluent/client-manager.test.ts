import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import {
  type ClientManagerConfig,
  type ConfluentCloudRestClientManager,
} from "@src/confluent/client-manager.js";
import { DirectClientManager } from "@src/confluent/direct-client-manager.js";
import type { ConfluentAuth } from "@src/confluent/middleware.js";
import { describe, expect, it } from "vitest";

const apiKeyAuth: ConfluentAuth = {
  apiKey: "k",
  apiSecret: "s",
};

function buildConfig(
  overrides: Partial<ClientManagerConfig> = {},
): ClientManagerConfig {
  return {
    kafka: { "client.id": "test" },
    endpoints: {
      cloud: undefined,
      flink: undefined,
      schemaRegistry: undefined,
      kafka: undefined,
      telemetry: undefined,
      ...overrides.endpoints,
    },
    auth: {
      cloud: apiKeyAuth,
      tableflow: apiKeyAuth,
      flink: apiKeyAuth,
      schemaRegistry: apiKeyAuth,
      kafka: apiKeyAuth,
      telemetry: apiKeyAuth,
      ...overrides.auth,
    },
  };
}

describe("BaseClientManager (via DirectClientManager)", () => {
  describe("REST client getters", () => {
    type RestGetterKey = keyof ConfluentCloudRestClientManager;

    const restCases: Array<{
      getter: RestGetterKey;
      endpointKey: keyof ClientManagerConfig["endpoints"];
      url: string;
      errorFragment: string;
    }> = [
      {
        getter: "getConfluentCloudRestClient",
        endpointKey: "cloud",
        url: "https://api.confluent.cloud",
        errorFragment: "Confluent Cloud REST endpoint not configured",
      },
      {
        getter: "getConfluentCloudTableflowRestClient",
        endpointKey: "cloud", // Tableflow shares the cloud base URL
        url: "https://api.confluent.cloud",
        errorFragment: "Confluent Cloud Tableflow REST endpoint not configured",
      },
      {
        getter: "getConfluentCloudFlinkRestClient",
        endpointKey: "flink",
        url: "https://flink.us-east-1.aws.confluent.cloud",
        errorFragment: "Confluent Cloud Flink REST endpoint not configured",
      },
      {
        getter: "getConfluentCloudSchemaRegistryRestClient",
        endpointKey: "schemaRegistry",
        url: "https://psrc-abc.us-east-1.aws.confluent.cloud",
        errorFragment:
          "Confluent Cloud Schema Registry REST endpoint not configured",
      },
      {
        getter: "getConfluentCloudKafkaRestClient",
        endpointKey: "kafka",
        url: "https://kafka-rest.example.com",
        errorFragment: "Confluent Cloud Kafka REST endpoint not configured",
      },
      {
        getter: "getConfluentCloudTelemetryRestClient",
        endpointKey: "telemetry",
        url: "https://api.telemetry.confluent.cloud",
        errorFragment: "Confluent Cloud Telemetry endpoint not configured",
      },
    ];

    for (const { getter, endpointKey, url, errorFragment } of restCases) {
      it(`${getter} should return a client when ${endpointKey} endpoint is configured`, () => {
        const cm = new DirectClientManager(
          buildConfig({ endpoints: { [endpointKey]: url } }),
        );
        const client = cm[getter]();
        expect(client).toBeDefined();
        expect(typeof client.GET).toBe("function");
      });

      it(`${getter} should throw when the endpoint is not configured`, () => {
        const cm = new DirectClientManager(buildConfig());
        expect(() => cm[getter]()).toThrow(errorFragment);
      });
    }
  });

  describe("getSchemaRegistryClient", () => {
    const url = "https://psrc-abc.us-east-1.aws.confluent.cloud";

    it("should return a SchemaRegistryClient when api_key and secret are both set", () => {
      const cm = new DirectClientManager(
        buildConfig({
          endpoints: { schemaRegistry: url },
          auth: { schemaRegistry: { apiKey: "k", apiSecret: "s" } },
        }),
      );
      expect(cm.getSchemaRegistryClient()).toBeInstanceOf(SchemaRegistryClient);
    });

    it("should return a SchemaRegistryClient when no credentials are supplied (anonymous)", () => {
      const cm = new DirectClientManager(
        buildConfig({
          endpoints: { schemaRegistry: url },
          auth: { schemaRegistry: { apiKey: undefined, apiSecret: undefined } },
        }),
      );
      expect(cm.getSchemaRegistryClient()).toBeInstanceOf(SchemaRegistryClient);
    });

    it("should throw on partial credentials (apiKey without apiSecret)", () => {
      const cm = new DirectClientManager(
        buildConfig({
          endpoints: { schemaRegistry: url },
          auth: { schemaRegistry: { apiKey: "k", apiSecret: undefined } },
        }),
      );
      expect(() => cm.getSchemaRegistryClient()).toThrow(
        "SCHEMA_REGISTRY_API_SECRET",
      );
    });

    it("should throw on partial credentials (apiSecret without apiKey)", () => {
      const cm = new DirectClientManager(
        buildConfig({
          endpoints: { schemaRegistry: url },
          auth: { schemaRegistry: { apiKey: undefined, apiSecret: "s" } },
        }),
      );
      expect(() => cm.getSchemaRegistryClient()).toThrow(
        "SCHEMA_REGISTRY_API_KEY",
      );
    });

    it("should throw when the schema registry endpoint is not configured", () => {
      const cm = new DirectClientManager(buildConfig());
      expect(() => cm.getSchemaRegistryClient()).toThrow(
        "Schema Registry endpoint not configured",
      );
    });

    it("should throw when the schema registry auth is the oauth variant (SDK OAuth not supported yet)", () => {
      const cm = new DirectClientManager(
        buildConfig({
          endpoints: { schemaRegistry: url },
          auth: {
            schemaRegistry: { type: "oauth", getToken: () => "token" },
          },
        }),
      );
      expect(() => cm.getSchemaRegistryClient()).toThrow(
        "Schema Registry OAuth authentication is not supported",
      );
    });
  });
});

describe("DirectClientManager", () => {
  describe("disconnect", () => {
    it("should resolve without error on a fresh instance (no Kafka clients materialized)", async () => {
      const cm = new DirectClientManager(buildConfig());
      await expect(cm.disconnect()).resolves.toBeUndefined();
    });
  });
});
