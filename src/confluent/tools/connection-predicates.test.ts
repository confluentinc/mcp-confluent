import type { DirectConnectionConfig } from "@src/config/index.js";
import type { ConnectionConfig } from "@src/config/models.js";
import {
  ENABLED,
  type PredicateResult,
  ToolDisabledReason,
  allOf,
  connectionIdsWhere,
  connectionReasonsWhere,
  hasCCloudCatalogSupport,
  hasConfluentCloud,
  hasDirectConfluentCloud,
  hasFlink,
  hasKafka,
  hasKafkaAuth,
  hasKafkaBootstrap,
  hasKafkaRestWithAuth,
  hasSchemaRegistry,
  hasTableflow,
  hasTelemetry,
} from "@src/confluent/tools/connection-predicates.js";
import { describe, expect, it, vi } from "vitest";

function conn(
  fields: Omit<DirectConnectionConfig, "type">,
): DirectConnectionConfig {
  return { type: "direct", ...fields };
}

function disabledFor(reason: ToolDisabledReason): PredicateResult {
  return { enabled: false, reason };
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
  ccloud_env: "devel",
};

describe("connection-predicates.ts", () => {
  describe("hasKafka()", () => {
    it("should return enabled when the kafka block is present", () => {
      expect(hasKafka(KAFKA_CONN)).toEqual(ENABLED);
    });

    it("should report MissingKafkaBlock when the kafka block is absent", () => {
      expect(hasKafka(SCHEMA_REGISTRY_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaBlock),
      );
    });

    it("should report OAuthNoServiceBlocks for an OAuth connection", () => {
      expect(hasKafka(OAUTH_CONN)).toEqual(
        disabledFor(ToolDisabledReason.OAuthNoServiceBlocks),
      );
    });
  });

  describe("hasKafkaBootstrap()", () => {
    it("should return enabled when kafka.bootstrap_servers is present", () => {
      expect(hasKafkaBootstrap(KAFKA_CONN)).toEqual(ENABLED);
    });

    it("should report MissingKafkaBlock when kafka block is absent", () => {
      expect(hasKafkaBootstrap(SCHEMA_REGISTRY_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaBlock),
      );
    });

    it("should report MissingKafkaBootstrap when kafka block is present but bootstrap_servers is absent", () => {
      expect(hasKafkaBootstrap(KAFKA_REST_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaBootstrap),
      );
    });

    it("should report OAuthNoServiceBlocks for an OAuth connection", () => {
      expect(hasKafkaBootstrap(OAUTH_CONN)).toEqual(
        disabledFor(ToolDisabledReason.OAuthNoServiceBlocks),
      );
    });
  });

  describe("hasKafkaAuth()", () => {
    it("should return enabled when kafka.auth is present", () => {
      expect(hasKafkaAuth(KAFKA_REST_WITH_AUTH_CONN)).toEqual(ENABLED);
    });

    it("should report MissingKafkaBlock when the kafka block is absent", () => {
      expect(hasKafkaAuth(SCHEMA_REGISTRY_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaBlock),
      );
    });

    it("should report MissingKafkaAuth when the kafka block has no auth", () => {
      expect(hasKafkaAuth(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaAuth),
      );
    });

    it("should report OAuthNoServiceBlocks for an OAuth connection", () => {
      expect(hasKafkaAuth(OAUTH_CONN)).toEqual(
        disabledFor(ToolDisabledReason.OAuthNoServiceBlocks),
      );
    });
  });

  describe("hasKafkaRestWithAuth()", () => {
    it("should return enabled when kafka.rest_endpoint and auth are both present", () => {
      expect(hasKafkaRestWithAuth(KAFKA_REST_WITH_AUTH_CONN)).toEqual(ENABLED);
    });

    it("should report MissingKafkaBlock when kafka block is absent", () => {
      expect(hasKafkaRestWithAuth(SCHEMA_REGISTRY_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaBlock),
      );
    });

    it("should report MissingKafkaRestEndpoint when kafka block has no rest_endpoint", () => {
      expect(hasKafkaRestWithAuth(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaRestEndpoint),
      );
    });

    it("should report MissingKafkaAuth when rest_endpoint is present but auth is absent", () => {
      expect(hasKafkaRestWithAuth(KAFKA_REST_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaAuth),
      );
    });

    it("should report OAuthNoServiceBlocks for an OAuth connection", () => {
      expect(hasKafkaRestWithAuth(OAUTH_CONN)).toEqual(
        disabledFor(ToolDisabledReason.OAuthNoServiceBlocks),
      );
    });
  });

  describe("hasSchemaRegistry()", () => {
    it("should return enabled when the schema_registry block is present", () => {
      expect(hasSchemaRegistry(SCHEMA_REGISTRY_CONN)).toEqual(ENABLED);
    });

    it("should report MissingSchemaRegistryBlock when the schema_registry block is absent", () => {
      expect(hasSchemaRegistry(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingSchemaRegistryBlock),
      );
    });

    it("should report OAuthNoServiceBlocks for an OAuth connection", () => {
      expect(hasSchemaRegistry(OAUTH_CONN)).toEqual(
        disabledFor(ToolDisabledReason.OAuthNoServiceBlocks),
      );
    });
  });

  describe("hasConfluentCloud()", () => {
    it("should return enabled when the confluent_cloud block is present", () => {
      expect(hasConfluentCloud(CONFLUENT_CLOUD_CONN)).toEqual(ENABLED);
    });

    it("should report MissingConfluentCloudBlock when the confluent_cloud block is absent on a direct connection", () => {
      expect(hasConfluentCloud(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingConfluentCloudBlock),
      );
    });

    it("should return enabled unconditionally for an OAuth connection", () => {
      // OAuth gets the CCloud REST URL from its Auth0 env, so it always reaches the CP surface.
      expect(hasConfluentCloud(OAUTH_CONN)).toEqual(ENABLED);
    });
  });

  describe("hasDirectConfluentCloud()", () => {
    it("should return enabled when the confluent_cloud block is present on a direct connection", () => {
      expect(hasDirectConfluentCloud(CONFLUENT_CLOUD_CONN)).toEqual(ENABLED);
    });

    it("should report MissingConfluentCloudBlock when the confluent_cloud block is absent on a direct connection", () => {
      expect(hasDirectConfluentCloud(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingConfluentCloudBlock),
      );
    });

    it("should report OAuthNotDirectCapable for an OAuth connection", () => {
      expect(hasDirectConfluentCloud(OAUTH_CONN)).toEqual(
        disabledFor(ToolDisabledReason.OAuthNotDirectCapable),
      );
    });
  });

  describe("hasFlink()", () => {
    it("should return enabled when the flink block is present", () => {
      expect(hasFlink(FLINK_CONN)).toEqual(ENABLED);
    });

    it("should report MissingFlinkBlock when the flink block is absent", () => {
      expect(hasFlink(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingFlinkBlock),
      );
    });

    it("should report OAuthNoServiceBlocks for an OAuth connection", () => {
      expect(hasFlink(OAUTH_CONN)).toEqual(
        disabledFor(ToolDisabledReason.OAuthNoServiceBlocks),
      );
    });
  });

  describe("hasTelemetry()", () => {
    it("should return enabled when the telemetry block is present", () => {
      expect(hasTelemetry(TELEMETRY_CONN)).toEqual(ENABLED);
    });

    it("should report MissingTelemetryBlock when the telemetry block is absent", () => {
      expect(hasTelemetry(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingTelemetryBlock),
      );
    });

    it("should report OAuthNoServiceBlocks for an OAuth connection", () => {
      expect(hasTelemetry(OAUTH_CONN)).toEqual(
        disabledFor(ToolDisabledReason.OAuthNoServiceBlocks),
      );
    });
  });

  describe("hasCCloudCatalogSupport()", () => {
    it("should return enabled when schema_registry has api_key auth", () => {
      expect(hasCCloudCatalogSupport(CCLOUD_SR_CONN)).toEqual(ENABLED);
    });

    it("should report MissingSchemaRegistryApiKeyAuth when schema_registry has no auth", () => {
      expect(hasCCloudCatalogSupport(SCHEMA_REGISTRY_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingSchemaRegistryApiKeyAuth),
      );
    });

    it("should report MissingSchemaRegistryBlock when the confluent_cloud block is present but schema_registry is absent", () => {
      expect(hasCCloudCatalogSupport(CONFLUENT_CLOUD_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingSchemaRegistryBlock),
      );
    });

    it("should report MissingSchemaRegistryBlock when neither block is present", () => {
      expect(hasCCloudCatalogSupport(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingSchemaRegistryBlock),
      );
    });

    it("should report OAuthNoServiceBlocks for an OAuth connection", () => {
      expect(hasCCloudCatalogSupport(OAUTH_CONN)).toEqual(
        disabledFor(ToolDisabledReason.OAuthNoServiceBlocks),
      );
    });
  });

  describe("hasTableflow()", () => {
    it("should return enabled when the tableflow block is present", () => {
      expect(hasTableflow(TABLEFLOW_CONN)).toEqual(ENABLED);
    });

    it("should report MissingTableflowBlock when the tableflow block is absent", () => {
      expect(hasTableflow(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingTableflowBlock),
      );
    });

    it("should report OAuthNoServiceBlocks for an OAuth connection", () => {
      expect(hasTableflow(OAUTH_CONN)).toEqual(
        disabledFor(ToolDisabledReason.OAuthNoServiceBlocks),
      );
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

  describe("connectionReasonsWhere()", () => {
    it("should return an empty map when there are no connections", () => {
      expect(connectionReasonsWhere({}, hasKafka)).toEqual(new Map());
    });

    it("should record one verdict per connection, preserving entry order", () => {
      const connections: Record<string, ConnectionConfig> = {
        kafka: KAFKA_CONN,
        sr: SCHEMA_REGISTRY_CONN,
        oauth: OAUTH_CONN,
      };
      const verdicts = connectionReasonsWhere(connections, hasKafka);
      expect(verdicts).toEqual(
        new Map([
          ["kafka", ENABLED],
          ["sr", disabledFor(ToolDisabledReason.MissingKafkaBlock)],
          ["oauth", disabledFor(ToolDisabledReason.OAuthNoServiceBlocks)],
        ]),
      );
      expect(Array.from(verdicts.keys())).toEqual(["kafka", "sr", "oauth"]);
    });

    it("should report enabled for every connection when all match the predicate", () => {
      const connections: Record<string, ConnectionConfig> = {
        a: KAFKA_CONN,
        b: KAFKA_REST_CONN,
      };
      expect(connectionReasonsWhere(connections, hasKafka)).toEqual(
        new Map([
          ["a", ENABLED],
          ["b", ENABLED],
        ]),
      );
    });

    it("should report disabled for every connection when none match the predicate", () => {
      const connections: Record<string, ConnectionConfig> = {
        sr: SCHEMA_REGISTRY_CONN,
        oauth: OAUTH_CONN,
      };
      expect(connectionReasonsWhere(connections, hasFlink)).toEqual(
        new Map([
          ["sr", disabledFor(ToolDisabledReason.MissingFlinkBlock)],
          ["oauth", disabledFor(ToolDisabledReason.OAuthNoServiceBlocks)],
        ]),
      );
    });
  });

  describe("allOf()", () => {
    it("should return ENABLED when every predicate passes", () => {
      const combined = allOf(hasKafka, hasKafkaAuth);
      expect(combined(KAFKA_REST_WITH_AUTH_CONN)).toEqual(ENABLED);
    });

    it("should return the first failing verdict when an early predicate fails", () => {
      // hasFlink fails on KAFKA_CONN before hasKafkaAuth gets a chance.
      const combined = allOf(hasFlink, hasKafkaAuth);
      expect(combined(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingFlinkBlock),
      );
    });

    it("should return the failing verdict from a later predicate when earlier predicates pass", () => {
      // hasKafka passes on KAFKA_CONN; hasKafkaAuth then fails because
      // KAFKA_CONN has no auth.
      const combined = allOf(hasKafka, hasKafkaAuth);
      expect(combined(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaAuth),
      );
    });

    it("should short-circuit and not evaluate predicates after the first failure", () => {
      const laterPredicate = vi.fn(() => ENABLED);
      const combined = allOf(hasFlink, laterPredicate);
      combined(KAFKA_CONN);
      expect(laterPredicate).not.toHaveBeenCalled();
    });

    it("should return ENABLED when called with zero predicates", () => {
      const combined = allOf();
      expect(combined(KAFKA_CONN)).toEqual(ENABLED);
    });
  });
});
