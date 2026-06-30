import type { DirectConnectionConfig } from "@src/config/index.js";
import type { ConnectionConfig } from "@src/config/models.js";
import {
  ENABLED,
  type PredicateResult,
  ToolDisabledReason,
  allOf,
  flinkWithTelemetry,
  flinkWithTelemetryOrOAuth,
  hasCCloudCatalogOrOAuth,
  hasCCloudCatalogSupport,
  hasConfluentCloud,
  hasConfluentCloudOrOAuth,
  hasFlink,
  hasFlinkOrOAuth,
  hasKafka,
  hasKafkaAuth,
  hasKafkaBootstrap,
  hasKafkaRestWithAuth,
  hasSchemaRegistry,
  hasSchemaRegistryOrOAuth,
  hasTableflow,
  hasTableflowOrOAuth,
  hasTelemetry,
  hasTelemetryOrOAuth,
  kafkaBootstrapOrOAuth,
  kafkaRestWithAuthOrOAuth,
  widenForOAuth,
} from "@src/confluent/tools/connection-predicates.js";
import { describe, expect, it, vi } from "vitest";

function directConn(
  fields: Omit<DirectConnectionConfig, "type">,
): DirectConnectionConfig {
  return { type: "direct", ...fields };
}

function disabledFor(reason: ToolDisabledReason): PredicateResult {
  return { enabled: false, reason };
}

const KAFKA_CONN = directConn({ kafka: { bootstrap_servers: "broker:9092" } });
const KAFKA_REST_CONN = directConn({
  kafka: { rest_endpoint: "http://kafka-rest:8082" },
});
const KAFKA_REST_WITH_AUTH_CONN = directConn({
  kafka: {
    rest_endpoint: "http://kafka-rest:8082",
    auth: { type: "api_key", key: "k", secret: "s" },
  },
});
const SCHEMA_REGISTRY_CONN = directConn({
  schema_registry: { endpoint: "http://schema-registry:8081" },
});
const CONFLUENT_CLOUD_CONN = directConn({
  confluent_cloud: {
    endpoint: "https://api.confluent.cloud",
    auth: { type: "api_key", key: "k", secret: "s" },
  },
});
const FLINK_CONN = directConn({
  flink: {
    endpoint: "https://flink.confluent.cloud",
    auth: { type: "api_key", key: "k", secret: "s" },
    environment_id: "env-abc",
    organization_id: "org-123",
    compute_pool_id: "lfcp-xyz",
  },
});
const TELEMETRY_CONN = directConn({
  telemetry: {
    endpoint: "https://api.telemetry.confluent.cloud",
    auth: { type: "api_key", key: "k", secret: "s" },
  },
});

const TABLEFLOW_CONN = directConn({
  tableflow: { auth: { type: "api_key", key: "k", secret: "s" } },
});

const CCLOUD_SR_CONN = directConn({
  schema_registry: {
    endpoint: "https://psrc-abc.us-east-1.aws.confluent.cloud",
    auth: { type: "api_key", key: "k", secret: "s" },
  },
  confluent_cloud: {
    endpoint: "https://api.confluent.cloud",
    auth: { type: "api_key", key: "k", secret: "s" },
  },
});

// Self-managed Confluent Platform deployment with HTTP Basic Auth in front of
// its Schema Registry. The auth shape collides with CCloud's api_key shape, but
// the absence of a confluent_cloud block distinguishes the two.
const CP_AUTH_SR_CONN = directConn({
  schema_registry: {
    endpoint: "https://cp-sr.internal:8081",
    auth: { type: "api_key", key: "k", secret: "s" },
  },
});

const FLINK_AND_TELEMETRY_CONN = directConn({
  flink: {
    endpoint: "https://flink.confluent.cloud",
    auth: { type: "api_key", key: "k", secret: "s" },
    environment_id: "env-abc",
    organization_id: "org-123",
    compute_pool_id: "lfcp-xyz",
  },
  telemetry: {
    endpoint: "https://api.telemetry.confluent.cloud",
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

  describe("hasConfluentCloudOrOAuth()", () => {
    it("should return enabled when the confluent_cloud block is present", () => {
      expect(hasConfluentCloudOrOAuth(CONFLUENT_CLOUD_CONN)).toEqual(ENABLED);
    });

    it("should report MissingConfluentCloudBlock when the confluent_cloud block is absent on a direct connection", () => {
      expect(hasConfluentCloudOrOAuth(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingConfluentCloudBlock),
      );
    });

    it("should return enabled unconditionally for an OAuth connection", () => {
      // OAuth gets the CCloud REST URL from its Auth0 env, so it always reaches the CP surface.
      expect(hasConfluentCloudOrOAuth(OAUTH_CONN)).toEqual(ENABLED);
    });
  });

  describe("hasConfluentCloud()", () => {
    it("should return enabled when the confluent_cloud block is present on a direct connection", () => {
      expect(hasConfluentCloud(CONFLUENT_CLOUD_CONN)).toEqual(ENABLED);
    });

    it("should report MissingConfluentCloudBlock when the confluent_cloud block is absent on a direct connection", () => {
      expect(hasConfluentCloud(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingConfluentCloudBlock),
      );
    });

    it("should report OAuthNotDirectCapable for an OAuth connection", () => {
      expect(hasConfluentCloud(OAUTH_CONN)).toEqual(
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
    it("should return enabled when schema_registry has api_key auth and confluent_cloud is present", () => {
      expect(hasCCloudCatalogSupport(CCLOUD_SR_CONN)).toEqual(ENABLED);
    });

    it("should report MissingConfluentCloudBlock when schema_registry has api_key auth but confluent_cloud is absent (Confluent Platform with auth-protected SR)", () => {
      expect(hasCCloudCatalogSupport(CP_AUTH_SR_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingConfluentCloudBlock),
      );
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

  describe("widenForOAuth()", () => {
    it("should override the wrapped predicate and answer ENABLED for OAuth connections", () => {
      // hasKafkaBootstrap normally answers OAuthNoServiceBlocks for OAuth;
      // widenForOAuth lets the handler opt into accepting OAuth despite that.
      const widened = widenForOAuth(hasKafkaBootstrap);
      expect(widened(OAUTH_CONN)).toEqual(ENABLED);
    });

    it("should delegate to the wrapped predicate for direct connections (passing case)", () => {
      const widened = widenForOAuth(hasKafkaBootstrap);
      expect(widened(KAFKA_CONN)).toEqual(ENABLED);
    });

    it("should delegate to the wrapped predicate for direct connections (failing case)", () => {
      // KAFKA_REST_CONN has no bootstrap_servers; the wrapped predicate's
      // disabled verdict propagates unchanged for direct connections.
      const widened = widenForOAuth(hasKafkaBootstrap);
      expect(widened(KAFKA_REST_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaBootstrap),
      );
    });

    it("should not call the wrapped predicate at all for OAuth connections", () => {
      const wrapped = vi.fn(() => ENABLED);
      const widened = widenForOAuth(wrapped);
      widened(OAUTH_CONN);
      expect(wrapped).not.toHaveBeenCalled();
    });
  });

  describe("kafkaBootstrapOrOAuth", () => {
    it("should return ENABLED for a direct connection with kafka.bootstrap_servers", () => {
      expect(kafkaBootstrapOrOAuth(KAFKA_CONN)).toEqual(ENABLED);
    });

    it("should report MissingKafkaBootstrap for a direct connection whose kafka block has no bootstrap_servers", () => {
      expect(kafkaBootstrapOrOAuth(KAFKA_REST_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaBootstrap),
      );
    });

    it("should report MissingKafkaBlock for a direct connection without a kafka block", () => {
      expect(kafkaBootstrapOrOAuth(SCHEMA_REGISTRY_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaBlock),
      );
    });

    it("should return ENABLED for an OAuth connection (the predicate is widened)", () => {
      expect(kafkaBootstrapOrOAuth(OAUTH_CONN)).toEqual(ENABLED);
    });
  });

  describe("kafkaRestWithAuthOrOAuth", () => {
    it("should return ENABLED for a direct connection with kafka.rest_endpoint and kafka.auth", () => {
      expect(kafkaRestWithAuthOrOAuth(KAFKA_REST_WITH_AUTH_CONN)).toEqual(
        ENABLED,
      );
    });

    it("should report MissingKafkaRestEndpoint for a direct kafka block without rest_endpoint", () => {
      expect(kafkaRestWithAuthOrOAuth(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaRestEndpoint),
      );
    });

    it("should report MissingKafkaAuth for a direct connection with rest_endpoint but no auth", () => {
      expect(kafkaRestWithAuthOrOAuth(KAFKA_REST_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaAuth),
      );
    });

    it("should report MissingKafkaBlock for a direct connection without a kafka block", () => {
      expect(kafkaRestWithAuthOrOAuth(SCHEMA_REGISTRY_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingKafkaBlock),
      );
    });

    it("should return ENABLED for an OAuth connection (the predicate is widened)", () => {
      expect(kafkaRestWithAuthOrOAuth(OAUTH_CONN)).toEqual(ENABLED);
    });
  });

  describe("hasSchemaRegistryOrOAuth", () => {
    it("should return ENABLED for a direct connection with a schema_registry block", () => {
      expect(hasSchemaRegistryOrOAuth(SCHEMA_REGISTRY_CONN)).toEqual(ENABLED);
    });

    it("should report MissingSchemaRegistryBlock for a direct connection without a schema_registry block", () => {
      expect(hasSchemaRegistryOrOAuth(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingSchemaRegistryBlock),
      );
    });

    it("should return ENABLED for an OAuth connection (the predicate is widened)", () => {
      expect(hasSchemaRegistryOrOAuth(OAUTH_CONN)).toEqual(ENABLED);
    });
  });

  describe("hasTelemetryOrOAuth", () => {
    it("should return ENABLED for a direct connection with a telemetry block", () => {
      expect(hasTelemetryOrOAuth(TELEMETRY_CONN)).toEqual(ENABLED);
    });

    it("should report MissingTelemetryBlock for a direct connection without a telemetry block", () => {
      expect(hasTelemetryOrOAuth(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingTelemetryBlock),
      );
    });

    it("should return ENABLED for an OAuth connection (the predicate is widened)", () => {
      expect(hasTelemetryOrOAuth(OAUTH_CONN)).toEqual(ENABLED);
    });
  });

  describe("hasTableflowOrOAuth", () => {
    it("should return ENABLED for a direct connection with a tableflow block", () => {
      expect(hasTableflowOrOAuth(TABLEFLOW_CONN)).toEqual(ENABLED);
    });

    it("should report MissingTableflowBlock for a direct connection without a tableflow block", () => {
      expect(hasTableflowOrOAuth(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingTableflowBlock),
      );
    });

    it("should return ENABLED for an OAuth connection (the predicate is widened)", () => {
      expect(hasTableflowOrOAuth(OAUTH_CONN)).toEqual(ENABLED);
    });
  });

  describe("hasFlinkOrOAuth", () => {
    it("should return ENABLED for a direct connection with a flink block", () => {
      expect(hasFlinkOrOAuth(FLINK_CONN)).toEqual(ENABLED);
    });

    it("should report MissingFlinkBlock for a direct connection without a flink block", () => {
      expect(hasFlinkOrOAuth(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingFlinkBlock),
      );
    });

    it("should return ENABLED for an OAuth connection (the predicate is widened)", () => {
      expect(hasFlinkOrOAuth(OAUTH_CONN)).toEqual(ENABLED);
    });
  });

  describe("hasCCloudCatalogOrOAuth", () => {
    it("should return ENABLED for a direct CCloud-hosted Schema Registry connection", () => {
      expect(hasCCloudCatalogOrOAuth(CCLOUD_SR_CONN)).toEqual(ENABLED);
    });

    it("should report MissingSchemaRegistryBlock for a direct connection without a schema_registry block", () => {
      expect(hasCCloudCatalogOrOAuth(KAFKA_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingSchemaRegistryBlock),
      );
    });

    it("should report MissingConfluentCloudBlock for a direct CP connection with auth-protected SR but no confluent_cloud block", () => {
      expect(hasCCloudCatalogOrOAuth(CP_AUTH_SR_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingConfluentCloudBlock),
      );
    });

    it("should return ENABLED for an OAuth connection (the predicate is widened)", () => {
      expect(hasCCloudCatalogOrOAuth(OAUTH_CONN)).toEqual(ENABLED);
    });
  });

  describe("flinkWithTelemetry", () => {
    it("should return ENABLED when both flink and telemetry blocks are present on a direct connection", () => {
      expect(flinkWithTelemetry(FLINK_AND_TELEMETRY_CONN)).toEqual(ENABLED);
    });

    it("should report MissingFlinkBlock when only the telemetry block is present (first conjunct fails)", () => {
      expect(flinkWithTelemetry(TELEMETRY_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingFlinkBlock),
      );
    });

    it("should report MissingTelemetryBlock when only the flink block is present (second conjunct fails)", () => {
      expect(flinkWithTelemetry(FLINK_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingTelemetryBlock),
      );
    });

    it("should report OAuthNoServiceBlocks for an OAuth connection", () => {
      expect(flinkWithTelemetry(OAUTH_CONN)).toEqual(
        disabledFor(ToolDisabledReason.OAuthNoServiceBlocks),
      );
    });
  });

  describe("flinkWithTelemetryOrOAuth", () => {
    it("should return ENABLED for a direct connection with both flink and telemetry blocks", () => {
      expect(flinkWithTelemetryOrOAuth(FLINK_AND_TELEMETRY_CONN)).toEqual(
        ENABLED,
      );
    });

    it("should report MissingFlinkBlock when only the telemetry block is present", () => {
      expect(flinkWithTelemetryOrOAuth(TELEMETRY_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingFlinkBlock),
      );
    });

    it("should report MissingTelemetryBlock when only the flink block is present", () => {
      expect(flinkWithTelemetryOrOAuth(FLINK_CONN)).toEqual(
        disabledFor(ToolDisabledReason.MissingTelemetryBlock),
      );
    });

    it("should return ENABLED for an OAuth connection (the predicate is widened)", () => {
      expect(flinkWithTelemetryOrOAuth(OAUTH_CONN)).toEqual(ENABLED);
    });
  });
});
