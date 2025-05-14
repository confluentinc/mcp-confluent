/**
 * @fileoverview Provides client management functionality for Kafka and Confluent Cloud services.
 */

import { KafkaJS } from "@confluentinc/kafka-javascript";
import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import {
  ConfluentAuth,
  ConfluentEndpoints,
  createAuthMiddleware,
} from "@src/confluent/middleware.js";
import { paths } from "@src/confluent/openapi-schema.js";
import { AsyncLazy, Lazy } from "@src/lazy.js";
import { logger } from "@src/logger.js";
import createClient, { Client } from "openapi-fetch";

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
  /** Gets a configured REST client for Confluent Cloud Schema Registry operations */
  getConfluentCloudSchemaRegistryRestClient(): Client<
    paths,
    `${string}/${string}`
  >;
  /** Gets a configured REST client for Confluent Cloud Kafka operations */
  getConfluentCloudKafkaRestClient(): Client<paths, `${string}/${string}`>;

  setConfluentCloudRestEndpoint(endpoint: string): void;
  setConfluentCloudFlinkEndpoint(endpoint: string): void;
  setConfluentCloudSchemaRegistryEndpoint(endpoint: string): void;
  setConfluentCloudKafkaRestEndpoint(endpoint: string): void;
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

export interface ClientManagerConfig {
  kafka: KafkaJS.CommonConstructorConfig;
  endpoints: ConfluentEndpoints;
  auth: {
    cloud: ConfluentAuth;
    flink: ConfluentAuth;
    schemaRegistry: ConfluentAuth;
    kafka: ConfluentAuth;
  };
}

/**
 * Default implementation of client management for Kafka and Confluent Cloud services.
 * Manages lifecycle and lazy initialization of various client connections.
 */
export class DefaultClientManager
  implements ClientManager, SchemaRegistryClientHandler
{
  private confluentCloudBaseUrl: string | undefined;
  private confluentCloudFlinkBaseUrl: string | undefined;
  private confluentCloudSchemaRegistryBaseUrl: string | undefined;
  private confluentCloudKafkaRestBaseUrl: string | undefined;
  private readonly kafkaClient: Lazy<KafkaJS.Kafka>;
  private readonly adminClient: AsyncLazy<KafkaJS.Admin>;
  private readonly producer: AsyncLazy<KafkaJS.Producer>;
  private readonly confluentCloudFlinkRestClient: Lazy<
    Client<paths, `${string}/${string}`>
  >;
  private readonly confluentCloudRestClient: Lazy<
    Client<paths, `${string}/${string}`>
  >;
  private readonly confluentCloudSchemaRegistryRestClient: Lazy<
    Client<paths, `${string}/${string}`>
  >;
  private readonly confluentCloudKafkaRestClient: Lazy<
    Client<paths, `${string}/${string}`>
  >;
  private readonly schemaRegistryClient: Lazy<SchemaRegistryClient>;

  /**
   * Creates a new DefaultClientManager instance.
   * @param config - Configuration for all clients
   */
  constructor(config: ClientManagerConfig) {
    this.confluentCloudBaseUrl = config.endpoints.cloud;
    this.confluentCloudFlinkBaseUrl = config.endpoints.flink;
    this.confluentCloudSchemaRegistryBaseUrl = config.endpoints.schemaRegistry;
    this.confluentCloudKafkaRestBaseUrl = config.endpoints.kafka;

    this.kafkaClient = new Lazy(() => new KafkaJS.Kafka(config.kafka));
    this.adminClient = new AsyncLazy(
      async () => {
        logger.info("Connecting Kafka Admin");
        const admin = this.kafkaClient.get().admin();
        await admin.connect();
        return admin;
      },
      (admin) => admin.disconnect(),
    );
    this.producer = new AsyncLazy(
      async () => {
        logger.info("Connecting Kafka Producer");
        const producer = this.kafkaClient.get().producer({
          "compression.type": "gzip",
          "linger.ms": 5,
        });
        await producer.connect();
        return producer;
      },
      (producer) => producer.disconnect(),
    );

    this.confluentCloudRestClient = new Lazy(() => {
      if (!this.confluentCloudBaseUrl) {
        throw new Error("Confluent Cloud REST endpoint not configured");
      }
      logger.info(
        `Initializing Confluent Cloud REST client for base URL ${this.confluentCloudBaseUrl}`,
      );
      const client = createClient<paths>({
        baseUrl: this.confluentCloudBaseUrl,
      });
      client.use(createAuthMiddleware(config.auth.cloud));
      return client;
    });

    this.confluentCloudFlinkRestClient = new Lazy(() => {
      if (!this.confluentCloudFlinkBaseUrl) {
        throw new Error("Confluent Cloud Flink REST endpoint not configured");
      }
      logger.info(
        `Initializing Confluent Cloud Flink REST client for base URL ${this.confluentCloudFlinkBaseUrl}`,
      );
      const client = createClient<paths>({
        baseUrl: this.confluentCloudFlinkBaseUrl,
      });
      client.use(createAuthMiddleware(config.auth.flink));
      return client;
    });

    this.confluentCloudSchemaRegistryRestClient = new Lazy(() => {
      if (!this.confluentCloudSchemaRegistryBaseUrl) {
        throw new Error(
          "Confluent Cloud Schema Registry REST endpoint not configured",
        );
      }
      logger.info(
        `Initializing Confluent Cloud Schema Registry REST client for base URL ${this.confluentCloudSchemaRegistryBaseUrl}`,
      );
      const client = createClient<paths>({
        baseUrl: this.confluentCloudSchemaRegistryBaseUrl,
      });
      client.use(createAuthMiddleware(config.auth.schemaRegistry));
      return client;
    });

    this.confluentCloudKafkaRestClient = new Lazy(() => {
      if (!this.confluentCloudKafkaRestBaseUrl) {
        throw new Error("Confluent Cloud Kafka REST endpoint not configured");
      }
      logger.info(
        `Initializing Confluent Cloud Kafka REST client for base URL ${this.confluentCloudKafkaRestBaseUrl}`,
      );
      const client = createClient<paths>({
        baseUrl: this.confluentCloudKafkaRestBaseUrl,
      });
      client.use(createAuthMiddleware(config.auth.kafka));
      return client;
    });

    this.schemaRegistryClient = new Lazy(() => {
      if (!this.confluentCloudSchemaRegistryBaseUrl) {
        throw new Error("Schema Registry endpoint not configured");
      }
      const { apiKey, apiSecret } = config.auth.schemaRegistry;
      return new SchemaRegistryClient({
        baseURLs: [this.confluentCloudSchemaRegistryBaseUrl],
        basicAuthCredentials: {
          credentialsSource: "USER_INFO",
          userInfo: `${apiKey}:${apiSecret}`,
        },
      });
    });
  }

  /** @inheritdoc */
  async getConsumer(sessionId?: string): Promise<KafkaJS.Consumer> {
    const baseGroupId = "mcp-confluent"; // should be configurable?
    const groupId = sessionId ? `${baseGroupId}-${sessionId}` : baseGroupId;
    logger.info(`Creating new Kafka Consumer with groupId: ${groupId}`);
    return this.kafkaClient.get().consumer({
      kafkaJS: {
        fromBeginning: true,
        groupId,
        allowAutoTopicCreation: false,
        autoCommit: false,
      },
    });
  }
  /**
   * a function that sets a new confluent cloud rest endpoint.
   * Closes the current client first.
   * @param endpoint the endpoint to set
   */
  setConfluentCloudRestEndpoint(endpoint: string): void {
    this.confluentCloudRestClient.close();
    this.confluentCloudBaseUrl = endpoint;
  }
  setConfluentCloudFlinkEndpoint(endpoint: string): void {
    this.confluentCloudFlinkRestClient.close();
    this.confluentCloudFlinkBaseUrl = endpoint;
  }
  setConfluentCloudSchemaRegistryEndpoint(endpoint: string): void {
    this.confluentCloudSchemaRegistryRestClient.close();
    this.confluentCloudSchemaRegistryBaseUrl = endpoint;
  }
  setConfluentCloudKafkaRestEndpoint(endpoint: string): void {
    this.confluentCloudKafkaRestClient.close();
    this.confluentCloudKafkaRestBaseUrl = endpoint;
  }

  /** @inheritdoc */
  getKafkaClient(): KafkaJS.Kafka {
    return this.kafkaClient.get();
  }

  /** @inheritdoc */
  getConfluentCloudFlinkRestClient(): Client<paths, `${string}/${string}`> {
    return this.confluentCloudFlinkRestClient.get();
  }

  /** @inheritdoc */
  getConfluentCloudRestClient(): Client<paths, `${string}/${string}`> {
    return this.confluentCloudRestClient.get();
  }

  /** @inheritdoc */
  getConfluentCloudSchemaRegistryRestClient(): Client<
    paths,
    `${string}/${string}`
  > {
    return this.confluentCloudSchemaRegistryRestClient.get();
  }

  /** @inheritdoc */
  getConfluentCloudKafkaRestClient(): Client<paths, `${string}/${string}`> {
    return this.confluentCloudKafkaRestClient.get();
  }

  /** @inheritdoc */
  async getAdminClient(): Promise<KafkaJS.Admin> {
    return this.adminClient.get();
  }

  /** @inheritdoc */
  async getProducer(): Promise<KafkaJS.Producer> {
    return this.producer.get();
  }

  /** @inheritdoc */
  async disconnect(): Promise<void> {
    await this.adminClient.close();
    await this.producer.close();
    this.kafkaClient.close();
  }

  /** @inheritdoc */
  getSchemaRegistryClient(): SchemaRegistryClient {
    return this.schemaRegistryClient.get();
  }
}
