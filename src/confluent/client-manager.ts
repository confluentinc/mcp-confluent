/**
 * @fileoverview Public client-manager contracts. Implementations live in sibling
 * files: {@link BaseClientManager} (REST + Schema Registry) in
 * `base-client-manager.ts`, and concrete subclasses ({@link DirectClientManager}
 * for api-key auth + native Kafka, plus the OAuth variant) alongside it.
 */

import { KafkaJS } from "@confluentinc/kafka-javascript";
import type { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { paths } from "@src/confluent/openapi-schema.js";
import { Client } from "openapi-fetch";

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
  getConfluentCloudFlinkRestClient(): Client<paths, `${string}/${string}`>;
  /** Gets a configured REST client for general Confluent Cloud operations */
  getConfluentCloudRestClient(): Client<paths, `${string}/${string}`>;
  /** Gets a configured REST client for Tableflow operations */
  getConfluentCloudTableflowRestClient(): Client<paths, `${string}/${string}`>;
  /**
   * Gets a configured REST client for Confluent Cloud Schema Registry operations.
   *
   * Under direct, the arg is ignored and the eagerly-built singleton is
   * returned (its baseUrl was set from `conn.schema_registry.endpoint` at
   * construction). Under OAuth, `envId` is required: a fresh client is built
   * per call against the resolved SR endpoint for the environment's SR
   * cluster, with bearer auth + the `target-sr-cluster` default header.
   */
  getConfluentCloudSchemaRegistryRestClient(
    envId?: string,
  ): Promise<Client<paths, `${string}/${string}`>>;
  /**
   * Gets a configured REST client for Confluent Cloud Kafka operations.
   *
   * Under direct, args are ignored and the eagerly-built singleton is returned
   * (its baseUrl was set from `conn.kafka.rest_endpoint` at construction).
   * Under OAuth, both `clusterId` and `envId` are required: a fresh client is
   * built per call against the resolved `spec.http_endpoint` for the given
   * cluster.
   */
  getConfluentCloudKafkaRestClient(
    clusterId?: string,
    envId?: string,
  ): Promise<Client<paths, `${string}/${string}`>>;
  /** Gets a configured REST client for Confluent Cloud Telemetry/Metrics API */
  getConfluentCloudTelemetryRestClient(): Client<paths, `${string}/${string}`>;
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
