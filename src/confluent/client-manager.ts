/**
 * @fileoverview Public client-manager contracts. Implementations live in sibling
 * files: {@link BaseClientManager} (REST + Schema Registry) in
 * `base-client-manager.ts`, and concrete subclasses ({@link DirectClientManager}
 * for api-key auth + native Kafka, plus the OAuth variant) alongside it.
 */

import type { KafkaJS } from "@confluentinc/kafka-javascript";
import type { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import type { paths } from "@src/confluent/openapi-schema.js";
import type { Client } from "openapi-fetch";

/**
 * Typed openapi-fetch client over the project's OpenAPI {@link paths}.
 * Shared alias so every REST surface in the codebase (cloud, flink,
 * tableflow, kafka REST, schema-registry REST, telemetry) advertises and
 * returns the same shape without restating the path-template generic.
 */
export type ConfluentRestClient = Client<paths, `${string}/${string}`>;

/**
 * Interface for managing Kafka client connections and operations.
 */
export interface KafkaClientManager {
  /** Gets the main Kafka client instance */
  getKafkaClient(): KafkaJS.Kafka;
  /** Gets a connected admin client for Kafka administration operations */
  getAdminClient(): Promise<KafkaJS.Admin>;
  /** Gets a connected producer client for publishing messages */
  getProducer(): Promise<KafkaJS.Producer>;
  /** Gets a connected consumer client for subscribing to topics */
  getConsumer(sessionId?: string): Promise<KafkaJS.Consumer>;
  /** Disconnects and cleans up all client connections */
  disconnect(): Promise<void>;
}

/**
 * Interface for managing Confluent Cloud REST client connections.
 */
export interface ConfluentCloudRestClientManager {
  /** Gets a configured REST client for Confluent Cloud Flink operations */
  getConfluentCloudFlinkRestClient(): ConfluentRestClient;
  /**
   * Env- and compute-pool-aware REST client for Confluent Cloud Flink
   * operations. This is the accessor Flink handlers call on both connection
   * types; the sync getter above is retained only as the base-class default
   * that this method delegates to on direct connections.
   *
   * Under direct, the args are ignored and a client is built against the
   * `flink.endpoint` from the connection config (the base URL is already
   * regional there). Under OAuth, both `computePoolId` and `envId` are
   * required: the Flink REST host is regional, so a fresh client is built per
   * call against `https://flink.<region>.<cloud>.<domain>` after resolving the
   * compute pool's `cloud` + `region` from the Confluent Cloud REST API.
   */
  getFlinkRestClient(
    computePoolId?: string,
    envId?: string,
  ): Promise<ConfluentRestClient>;
  /** Gets a configured REST client for general Confluent Cloud operations */
  getConfluentCloudRestClient(): ConfluentRestClient;
  /** Gets a configured REST client for Tableflow operations */
  getConfluentCloudTableflowRestClient(): ConfluentRestClient;
  /** Gets a configured REST client for Confluent Cloud Schema Registry operations */
  getConfluentCloudSchemaRegistryRestClient(): ConfluentRestClient;
  /**
   * Env-aware REST client for Schema Registry operations. Use from handlers
   * that need OAuth support; the existing sync getter above stays in use by
   * direct-only handlers (catalog/tag/search) and is unaffected by this
   * method.
   *
   * Under direct, `envId` is ignored; a client is built against the
   * `schema_registry.endpoint` from the connection config (same configuration
   * source as the sync getter). Under OAuth, `envId` is required: a fresh
   * client is built per call against the resolved SR host for the env's SR
   * cluster, with bearer auth + the `target-sr-cluster` default header.
   */
  getSchemaRegistryRestClient(envId?: string): Promise<ConfluentRestClient>;
  /**
   * Gets a configured REST client for Confluent Cloud Kafka operations.
   *
   * Under direct, args are ignored; a client is built against
   * `conn.kafka.rest_endpoint` from the connection config. Under OAuth, both
   * `clusterId` and `envId` are required: a fresh client is built per call
   * against the resolved `spec.http_endpoint` for the given cluster.
   */
  getConfluentCloudKafkaRestClient(
    clusterId?: string,
    envId?: string,
  ): Promise<ConfluentRestClient>;
  /** Gets a configured REST client for Confluent Cloud Telemetry/Metrics API */
  getConfluentCloudTelemetryRestClient(): ConfluentRestClient;
}

/**
 * Interface for managing Schema Registry client connections.
 */
export interface SchemaRegistryClientHandler {
  getSchemaRegistryClient(): SchemaRegistryClient;
}

export interface ClientManager
  extends KafkaClientManager,
    ConfluentCloudRestClientManager,
    SchemaRegistryClientHandler {
  getSchemaRegistryClient(): SchemaRegistryClient;
}
