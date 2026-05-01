/**
 * @fileoverview Direct (api-key) client manager — adds a native Kafka client to the
 * REST/Schema-Registry surfaces inherited from {@link BaseClientManager}.
 */

import { GlobalConfig, KafkaJS } from "@confluentinc/kafka-javascript";
import {
  CONFLUENT_CLOUD_DEFAULT_ENDPOINT,
  type DirectConnectionConfig,
} from "@src/config/models.js";
import {
  BaseClientManager,
  type BaseClientManagerConfig,
  type ClientManager,
} from "@src/confluent/client-manager.js";
import { AsyncLazy, Lazy } from "@src/lazy.js";
import { kafkaLogger, logger } from "@src/logger.js";

export interface DirectClientManagerConfig extends BaseClientManagerConfig {
  kafka: GlobalConfig;
}

/**
 * Direct API-key client manager. Adds a native Kafka client (admin, producer, consumer)
 * authenticated via SASL/PLAIN on top of the REST clients in {@link BaseClientManager}.
 */
export class DirectClientManager
  extends BaseClientManager
  implements ClientManager
{
  private readonly kafkaConfig: GlobalConfig;
  private readonly kafkaClient: Lazy<KafkaJS.Kafka>;
  private readonly adminClient: AsyncLazy<KafkaJS.Admin>;
  private readonly producer: AsyncLazy<KafkaJS.Producer>;

  constructor(config: DirectClientManagerConfig) {
    super(config);
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

  /** @inheritdoc */
  getKafkaClient(): KafkaJS.Kafka {
    return this.kafkaClient.get();
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

/**
 * Constructs a {@link DirectClientManager} from a single direct connection config.
 */
export function constructDirectClientManager(
  conn: DirectConnectionConfig,
): DirectClientManager {
  const kafkaClientConfig: GlobalConfig = {
    "client.id": "mcp-confluent",
    ...(conn.kafka?.bootstrap_servers && {
      "bootstrap.servers": conn.kafka.bootstrap_servers,
    }),
    ...(conn.kafka?.auth
      ? {
          "security.protocol": "sasl_ssl",
          "sasl.mechanisms": "PLAIN",
          "sasl.username": conn.kafka.auth.key,
          "sasl.password": conn.kafka.auth.secret,
        }
      : {}),
    ...conn.kafka?.extra_properties,
  };

  return new DirectClientManager({
    kafka: kafkaClientConfig,
    endpoints: {
      // BaseClientManager uses this as the Tableflow base URL too (see its constructor), so always supply the default.
      cloud: conn.confluent_cloud?.endpoint ?? CONFLUENT_CLOUD_DEFAULT_ENDPOINT,
      flink: conn.flink?.endpoint,
      schemaRegistry: conn.schema_registry?.endpoint,
      kafka: conn.kafka?.rest_endpoint,
      telemetry: conn.telemetry?.endpoint,
    },
    auth: {
      cloud: {
        apiKey: conn.confluent_cloud?.auth.key,
        apiSecret: conn.confluent_cloud?.auth.secret,
      },
      tableflow: {
        apiKey: conn.tableflow?.auth.key,
        apiSecret: conn.tableflow?.auth.secret,
      },
      flink: {
        apiKey: conn.flink?.auth.key,
        apiSecret: conn.flink?.auth.secret,
      },
      schemaRegistry: {
        apiKey: conn.schema_registry?.auth?.key,
        apiSecret: conn.schema_registry?.auth?.secret,
      },
      kafka: {
        apiKey: conn.kafka?.auth?.key,
        apiSecret: conn.kafka?.auth?.secret,
      },
      telemetry: {
        apiKey: conn.telemetry?.auth.key,
        apiSecret: conn.telemetry?.auth.secret,
      },
    },
  });
}
