/**
 * @fileoverview Provides client management functionality for Kafka and Confluent Cloud services.
 */

import { GlobalConfig, KafkaJS } from "@confluentinc/kafka-javascript";
import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import {
  ConfluentAuth,
  ConfluentEndpoints,
  createAuthMiddleware,
} from "@src/confluent/middleware.js";
import { paths } from "@src/confluent/openapi-schema.js";
import { AsyncLazy, Lazy } from "@src/lazy.js";
import { kafkaLogger, logger } from "@src/logger.js";
import createClient, { Client } from "openapi-fetch";
import { paths as telemetryPaths } from "@src/confluent/tools/handlers/metrics/types/telemetry-api.js";

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
  /** Gets a configured REST client for Confluent Cloud Schema Registry operations */
  getConfluentCloudSchemaRegistryRestClient(): Client<
    paths,
    `${string}/${string}`
  >;
  /** Gets a configured REST client for Confluent Cloud Kafka operations */
  getConfluentCloudKafkaRestClient(): Client<paths, `${string}/${string}`>;

  /** Gets a configured REST client for Confluent Cloud Telemetry Metrics API */
  getConfluentCloudTelemetryRestClient(): Client<
    telemetryPaths,
    `${string}/${string}`
  >;

  setConfluentCloudRestEndpoint(endpoint: string): void;
  setConfluentCloudFlinkEndpoint(endpoint: string): void;
  setConfluentCloudSchemaRegistryEndpoint(endpoint: string): void;
  setConfluentCloudKafkaRestEndpoint(endpoint: string): void;
  setConfluentCloudTelemetryEndpoint(endpoint: string): void;
  setConfluentCloudTableflowRestEndpoint(endpoint: string): void;
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
  kafka: GlobalConfig;
  endpoints: ConfluentEndpoints;
  auth: {
    cloud: ConfluentAuth;
    flink: ConfluentAuth;
    tableflow: ConfluentAuth;
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
  private confluentCloudTableflowBaseUrl: string | undefined;
  private confluentCloudFlinkBaseUrl: string | undefined;
  private confluentCloudSchemaRegistryBaseUrl: string | undefined;
  private confluentCloudKafkaRestBaseUrl: string | undefined;
  private confluentCloudTelemetryBaseUrl: string | undefined;
  private readonly kafkaConfig: GlobalConfig;
  private readonly kafkaClient: Lazy<KafkaJS.Kafka>;
  private readonly adminClient: AsyncLazy<KafkaJS.Admin>;
  private readonly producer: AsyncLazy<KafkaJS.Producer>;
  private readonly confluentCloudFlinkRestClient: Lazy<
    Client<paths, `${string}/${string}`>
  >;
  private readonly confluentCloudRestClient: Lazy<
    Client<paths, `${string}/${string}`>
  >;
  private readonly confluentCloudTableflowRestClient: Lazy<
    Client<paths, `${string}/${string}`>
  >;
  private readonly confluentCloudSchemaRegistryRestClient: Lazy<
    Client<paths, `${string}/${string}`>
  >;
  private readonly confluentCloudKafkaRestClient: Lazy<
    Client<paths, `${string}/${string}`>
  >;
  private readonly schemaRegistryClient: Lazy<SchemaRegistryClient>;

  private readonly confluentCloudTelemetryRestClient: Lazy<
    Client<telemetryPaths, `${string}/${string}`>
  >;
  // Store the config for access by tool handlers that need auth details
  public readonly config: ClientManagerConfig;
  /**
   * Creates a new DefaultClientManager instance.
   * @param config - Configuration for all clients
   */
  constructor(config: ClientManagerConfig) {
    this.config = config;
    this.confluentCloudBaseUrl = config.endpoints.cloud;
    this.confluentCloudTableflowBaseUrl = config.endpoints.cloud; // at the time of writing, apis are exposed on the same base url as confluent cloud
    this.confluentCloudFlinkBaseUrl = config.endpoints.flink;
    this.confluentCloudSchemaRegistryBaseUrl = config.endpoints.schemaRegistry;
    this.confluentCloudKafkaRestBaseUrl = config.endpoints.kafka;
    this.confluentCloudTelemetryBaseUrl = config.endpoints.telemetry;

    this.kafkaConfig = config.kafka;
    this.kafkaClient = new Lazy(
      () =>
        new KafkaJS.Kafka({
          ...this.kafkaConfig,
          kafkaJS: {
            logger: kafkaLogger,
            // we need to do this since typescript will complain that we are missing configs like `brokers` even though we are passing them in kafkaConfig above
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any,
        }),
    );
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
        const producer = this.kafkaClient.get().producer();
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

    this.confluentCloudTableflowRestClient = new Lazy(() => {
      if (!this.confluentCloudTableflowBaseUrl) {
        throw new Error(
          "Confluent Cloud Tableflow REST endpoint not configured",
        );
      }
      logger.info(
        `Initializing Confluent Cloud Tableflow REST client for base URL ${this.confluentCloudTableflowBaseUrl}`,
      );
      const client = createClient<paths>({
        baseUrl: this.confluentCloudTableflowBaseUrl,
      });
      client.use(createAuthMiddleware(config.auth.tableflow));
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

    this.confluentCloudTelemetryRestClient = new Lazy(() => {
      logger.info(
        `Initializing Confluent Cloud Telemetry REST client for base URL ${this.confluentCloudTelemetryBaseUrl}`,
      );
      const client = createClient<telemetryPaths>({
        baseUrl: this.confluentCloudTelemetryBaseUrl,
      });
      client.use(createAuthMiddleware(config.auth.cloud));
      return client;
    });
  }

  /** @inheritdoc */
  async getConsumer(sessionId?: string): Promise<KafkaJS.Consumer> {
    // Build the config inline, merging with defaults
    const baseGroupId =
      (this.kafkaConfig["group.id"] as string) || "mcp-confluent";
    const groupId = sessionId ? `${baseGroupId}-${sessionId}` : baseGroupId;
    const consumerConfig = {
      // Spread all user-provided config
      ...this.kafkaConfig,
      // Override with our logic
      "group.id": groupId,
      "auto.offset.reset": this.kafkaConfig["auto.offset.reset"] || "earliest",
      "allow.auto.create.topics":
        this.kafkaConfig["allow.auto.create.topics"] || false,
      "enable.auto.commit": this.kafkaConfig["enable.auto.commit"] || false,
    };
    return this.kafkaClient.get().consumer(consumerConfig);
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

  setConfluentCloudTableflowRestEndpoint(endpoint: string): void {
    this.confluentCloudTableflowRestClient.close();
    this.confluentCloudTableflowBaseUrl = endpoint;
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
  setConfluentCloudTelemetryEndpoint(endpoint: string): void {
    this.confluentCloudTelemetryRestClient.close();
    this.confluentCloudTelemetryBaseUrl = endpoint;
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
  getConfluentCloudTableflowRestClient(): Client<paths, `${string}/${string}`> {
    return this.confluentCloudTableflowRestClient.get();
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

  /** @inheritdoc */
  getConfluentCloudTelemetryRestClient(): Client<
    telemetryPaths,
    `${string}/${string}`
  > {
    return this.confluentCloudTelemetryRestClient.get();
  }
}
