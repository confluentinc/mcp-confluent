import type { DirectConnectionConfig } from "@src/config/index.js";
import type { ConnectionConfig } from "@src/config/models.js";
import {
  connectionIdsWhere,
  hasCCloudCatalogSupport,
  hasConfluentCloud,
  hasFlink,
  hasKafka,
  hasKafkaAuth,
  hasKafkaBootstrap,
  hasKafkaRestWithAuth,
  hasSchemaRegistry,
  hasTableflow,
  hasTelemetry,
} from "@src/confluent/tools/connection-predicates.js";
import { describe, expect, it } from "vitest";

function conn(
  fields: Omit<DirectConnectionConfig, "type">,
): DirectConnectionConfig {
  return { type: "direct", ...fields };
}

const KAFKA_CONN = conn({ kafka: { bootstrap_servers: "broker:9092" } });
const KAFKA_REST_CONN = conn({
  kafka: { rest_endpoint: "http://kafka-rest:8082" },
});
const KAFKA_REST_WITH_AUTH_CONN = conn({
  kafka: {
    rest_endpoint: "http://kafka-rest:8082",
    auth: { type: "api_key", key: "k", secret: "s" },
  },
});
const SCHEMA_REGISTRY_CONN = conn({
  schema_registry: { endpoint: "http://schema-registry:8081" },
});
const CONFLUENT_CLOUD_CONN = conn({
  confluent_cloud: {
    endpoint: "https://api.confluent.cloud",
    auth: { type: "api_key", key: "k", secret: "s" },
  },
});
const FLINK_CONN = conn({
  flink: {
    endpoint: "https://flink.confluent.cloud",
    auth: { type: "api_key", key: "k", secret: "s" },
    environment_id: "env-abc",
    organization_id: "org-123",
    compute_pool_id: "lfcp-xyz",
  },
});
const TELEMETRY_CONN = conn({
  telemetry: {
    endpoint: "https://api.telemetry.confluent.cloud",
    auth: { type: "api_key", key: "k", secret: "s" },
  },
});

const TABLEFLOW_CONN = conn({
  tableflow: { auth: { type: "api_key", key: "k", secret: "s" } },
});

const CCLOUD_SR_CONN = conn({
  schema_registry: {
    endpoint: "https://psrc-abc.us-east-1.aws.confluent.cloud",
    auth: { type: "api_key", key: "k", secret: "s" },
  },
});

const OAUTH_CONN: ConnectionConfig = {
  type: "oauth",
  development_env: "devel",
};

describe("connection-predicates.ts", () => {
  describe("hasKafka()", () => {
    it("should return true when the kafka block is present", () => {
      expect(hasKafka(KAFKA_CONN)).toBe(true);
    });

    it("should return false when the kafka block is absent", () => {
      expect(hasKafka(SCHEMA_REGISTRY_CONN)).toBe(false);
    });
  });

  describe("hasKafkaBootstrap()", () => {
    it("should return true when kafka.bootstrap_servers is present", () => {
      expect(hasKafkaBootstrap(KAFKA_CONN)).toBe(true);
    });

    it("should return false when kafka block is absent", () => {
      expect(hasKafkaBootstrap(SCHEMA_REGISTRY_CONN)).toBe(false);
    });

    it("should return false when kafka block is present but bootstrap_servers is absent", () => {
      expect(hasKafkaBootstrap(KAFKA_REST_CONN)).toBe(false);
    });
  });

  describe("hasKafkaAuth()", () => {
    it("should return true when kafka.auth is present", () => {
      expect(hasKafkaAuth(KAFKA_REST_WITH_AUTH_CONN)).toBe(true);
    });

    it("should return false when the kafka block is absent", () => {
      expect(hasKafkaAuth(SCHEMA_REGISTRY_CONN)).toBe(false);
    });

    it("should return false when the kafka block has no auth", () => {
      expect(hasKafkaAuth(KAFKA_CONN)).toBe(false);
    });
  });

  describe("hasKafkaRestWithAuth()", () => {
    it("should return true when kafka.rest_endpoint and auth are both present", () => {
      expect(hasKafkaRestWithAuth(KAFKA_REST_WITH_AUTH_CONN)).toBe(true);
    });

    it("should return false when kafka block is absent", () => {
      expect(hasKafkaRestWithAuth(SCHEMA_REGISTRY_CONN)).toBe(false);
    });

    it("should return false when kafka block has no rest_endpoint", () => {
      expect(hasKafkaRestWithAuth(KAFKA_CONN)).toBe(false);
    });

    it("should return false when rest_endpoint is present but auth is absent", () => {
      expect(hasKafkaRestWithAuth(KAFKA_REST_CONN)).toBe(false);
    });
  });

  describe("hasSchemaRegistry()", () => {
    it("should return true when the schema_registry block is present", () => {
      expect(hasSchemaRegistry(SCHEMA_REGISTRY_CONN)).toBe(true);
    });

    it("should return false when the schema_registry block is absent", () => {
      expect(hasSchemaRegistry(KAFKA_CONN)).toBe(false);
    });
  });

  describe("hasConfluentCloud()", () => {
    it("should return true when the confluent_cloud block is present", () => {
      expect(hasConfluentCloud(CONFLUENT_CLOUD_CONN)).toBe(true);
    });

    it("should return false when the confluent_cloud block is absent on a direct connection", () => {
      expect(hasConfluentCloud(KAFKA_CONN)).toBe(false);
    });

    it("should return true unconditionally for an OAuth connection", () => {
      // OAuth gets the CCloud REST URL from its Auth0 env, so it always reaches the CP surface.
      expect(hasConfluentCloud(OAUTH_CONN)).toBe(true);
    });
  });

  describe("hasFlink()", () => {
    it("should return true when the flink block is present", () => {
      expect(hasFlink(FLINK_CONN)).toBe(true);
    });

    it("should return false when the flink block is absent", () => {
      expect(hasFlink(KAFKA_CONN)).toBe(false);
    });
  });

  describe("hasTelemetry()", () => {
    it("should return true when the telemetry block is present", () => {
      expect(hasTelemetry(TELEMETRY_CONN)).toBe(true);
    });

    it("should return false when the telemetry block is absent", () => {
      expect(hasTelemetry(KAFKA_CONN)).toBe(false);
    });
  });

  describe("hasCCloudCatalogSupport()", () => {
    it("should return true when schema_registry has api_key auth", () => {
      expect(hasCCloudCatalogSupport(CCLOUD_SR_CONN)).toBe(true);
    });

    it("should return false when schema_registry has no auth", () => {
      expect(hasCCloudCatalogSupport(SCHEMA_REGISTRY_CONN)).toBe(false);
    });

    it("should return false when the confluent_cloud block is present but schema_registry is absent", () => {
      expect(hasCCloudCatalogSupport(CONFLUENT_CLOUD_CONN)).toBe(false);
    });

    it("should return false when neither block is present", () => {
      expect(hasCCloudCatalogSupport(KAFKA_CONN)).toBe(false);
    });
  });

  describe("hasTableflow()", () => {
    it("should return true when the tableflow block is present", () => {
      expect(hasTableflow(TABLEFLOW_CONN)).toBe(true);
    });

    it("should return false when the tableflow block is absent", () => {
      expect(hasTableflow(KAFKA_CONN)).toBe(false);
    });
  });

  describe("connectionIdsWhere()", () => {
    it("should return an empty array when no connections match the predicate", () => {
      const connections: Record<string, ConnectionConfig> = {
        sr: SCHEMA_REGISTRY_CONN,
      };
      expect(connectionIdsWhere(connections, hasKafka)).toEqual([]);
    });

    it("should return the matching connection ID when one connection matches", () => {
      const connections: Record<string, ConnectionConfig> = {
        kafka: KAFKA_CONN,
        sr: SCHEMA_REGISTRY_CONN,
      };
      expect(connectionIdsWhere(connections, hasKafka)).toEqual(["kafka"]);
    });

    it("should return all matching IDs when multiple connections satisfy the predicate", () => {
      const connections: Record<string, ConnectionConfig> = {
        kafka1: KAFKA_CONN,
        kafka2: KAFKA_REST_CONN,
        sr: SCHEMA_REGISTRY_CONN,
      };
      expect(connectionIdsWhere(connections, hasKafka)).toEqual([
        "kafka1",
        "kafka2",
      ]);
    });
  });
});
