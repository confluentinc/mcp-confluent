/**
 * @fileoverview Provides client management functionality for Kafka and Confluent Cloud services.
 */

import { KafkaJS } from "@confluentinc/kafka-javascript";
import {
  confluentCloudAuthMiddleware,
  flinkAuthMiddleware,
} from "@src/confluent/middleware.js";
import { paths } from "@src/confluent/openapi-schema.js";
import { AsyncLazy, Lazy } from "@src/lazy.js";
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
  getConsumer(): Promise<KafkaJS.Consumer>;
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
}

export interface ClientManager
  extends KafkaClientManager,
    ConfluentCloudRestClientManager {}

/**
 * Default implementation of client management for Kafka and Confluent Cloud services.
 * Manages lifecycle and lazy initialization of various client connections.
 */
export class DefaultClientManager implements ClientManager {
  private readonly kafkaClient: Lazy<KafkaJS.Kafka>;
  private readonly adminClient: AsyncLazy<KafkaJS.Admin>;
  private readonly producer: AsyncLazy<KafkaJS.Producer>;
  private readonly confluentCloudFlinkRestClient: Lazy<
    Client<paths, `${string}/${string}`>
  >;
  private readonly confluentCloudRestClient: Lazy<
    Client<paths, `${string}/${string}`>
  >;

  /**
   * Creates a new DefaultClientManager instance.
   * @param config - Configuration options for KafkaJS client
   * @param confluentCloudBaseUrl - Base URL for Confluent Cloud REST API
   * @param flinkBaseUrl - Base URL for Flink REST API
   */
  constructor(
    config: KafkaJS.CommonConstructorConfig,
    confluentCloudBaseUrl?: string,
    flinkBaseUrl?: string,
  ) {
    this.kafkaClient = new Lazy(() => new KafkaJS.Kafka(config));
    this.adminClient = new AsyncLazy(
      async () => {
        console.error("Connecting Kafka Admin");
        const admin = this.kafkaClient.get().admin();
        await admin.connect();
        return admin;
      },
      (admin) => admin.disconnect(),
    );
    this.producer = new AsyncLazy(
      async () => {
        console.error("Connecting Kafka Producer");
        const producer = this.kafkaClient.get().producer({
          kafkaJS: {
            acks: 1,
            compression: KafkaJS.CompressionTypes.GZIP,
          },
        });
        await producer.connect();
        return producer;
      },
      (producer) => producer.disconnect(),
    );

    this.confluentCloudRestClient = new Lazy(() => {
      console.error("Initializing Flink REST client");
      const client = createClient<paths>({
        baseUrl: confluentCloudBaseUrl,
      });
      client.use(flinkAuthMiddleware);
      return client;
    });

    this.confluentCloudFlinkRestClient = new Lazy(() => {
      console.error("Initializing Confluent Cloud REST client");
      const client = createClient<paths>({
        baseUrl: flinkBaseUrl,
      });
      client.use(confluentCloudAuthMiddleware);
      return client;
    });
  }
  getConsumer(): Promise<KafkaJS.Consumer> {
    throw new Error("Method not implemented.");
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
}
