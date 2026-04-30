/**
 * @fileoverview Provides client management functionality for Kafka and Confluent Cloud services.
 */

import { GlobalConfig, KafkaJS } from "@confluentinc/kafka-javascript";
import type { ClientConfig } from "@confluentinc/schemaregistry";
import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import {
  CONFLUENT_CLOUD_DEFAULT_ENDPOINT,
  type DirectConnectionConfig,
} from "@src/config/models.js";
import {
  ConfluentAuth,
  ConfluentEndpoints,
  createAuthMiddleware,
} from "@src/confluent/middleware.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import { paths } from "@src/confluent/openapi-schema.js";
import { AsyncLazy, Lazy } from "@src/lazy.js";
import { kafkaLogger, logger } from "@src/logger.js";
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
  /** Gets a configured REST client for Tableflow operations */
  getConfluentCloudTableflowRestClient(): Client<paths, `${string}/${string}`>;
  /** Gets a configured REST client for Confluent Cloud Schema Registry operations */
  getConfluentCloudSchemaRegistryRestClient(): Client<
    paths,
    `${string}/${string}`
  >;
  /** Gets a configured REST client for Confluent Cloud Kafka operations */
  getConfluentCloudKafkaRestClient(): Client<paths, `${string}/${string}`>;
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

export interface ClientManagerConfig {
  kafka: GlobalConfig;
  endpoints: ConfluentEndpoints;
  auth: {
    cloud: ConfluentAuth;
    flink: ConfluentAuth;
    tableflow: ConfluentAuth;
    schemaRegistry: ConfluentAuth;
    kafka: ConfluentAuth;
    telemetry: ConfluentAuth;
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
  private readonly confluentCloudTelemetryRestClient: Lazy<
    Client<paths, `${string}/${string}`>
  >;
  private readonly schemaRegistryClient: Lazy<SchemaRegistryClient>;

  /**
   * Creates a new DefaultClientManager instance.
   * @param config - Configuration for all clients
   */
  constructor(config: ClientManagerConfig) {
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

    this.confluentCloudTelemetryRestClient = new Lazy(() => {
      if (!this.confluentCloudTelemetryBaseUrl) {
        throw new Error("Confluent Cloud Telemetry endpoint not configured");
      }
      logger.info(
        `Initializing Confluent Cloud Telemetry REST client for base URL ${this.confluentCloudTelemetryBaseUrl}`,
      );
      const client = createClient<paths>({
        baseUrl: this.confluentCloudTelemetryBaseUrl,
      });
      client.use(createAuthMiddleware(config.auth.telemetry));
      return client;
    });

    this.schemaRegistryClient = new Lazy(() => {
      if (!this.confluentCloudSchemaRegistryBaseUrl) {
        throw new Error("Schema Registry endpoint not configured");
      }
      const schemaRegistryAuth = config.auth.schemaRegistry;
      if (schemaRegistryAuth.type === "oauth") {
        throw new Error(
          "Schema Registry OAuth authentication is not supported for SchemaRegistryClient yet. Configure SCHEMA_REGISTRY_API_KEY and SCHEMA_REGISTRY_API_SECRET instead.",
        );
      }
      const { apiKey, apiSecret } = schemaRegistryAuth;
      const clientConfig: ClientConfig = {
        baseURLs: [this.confluentCloudSchemaRegistryBaseUrl],
      };
      if (apiKey && apiSecret) {
        clientConfig.basicAuthCredentials = {
          credentialsSource: "USER_INFO",
          userInfo: `${apiKey}:${apiSecret}`,
        };
      } else if (apiKey || apiSecret) {
        const missing = apiKey
          ? "SCHEMA_REGISTRY_API_SECRET"
          : "SCHEMA_REGISTRY_API_KEY";
        throw new Error(
          `Partial credentials: ${missing} not set. Both SCHEMA_REGISTRY_API_KEY and SCHEMA_REGISTRY_API_SECRET are required for Schema Registry authentication.`,
        );
      }
      return new SchemaRegistryClient(clientConfig);
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
  getConfluentCloudTelemetryRestClient(): Client<paths, `${string}/${string}`> {
    return this.confluentCloudTelemetryRestClient.get();
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

/**
 * Resolves the per-surface {@link ConfluentAuth} slice for a single direct
 * connection. When `oauthHolder` is supplied, every cloud REST surface
 * authenticates with the `oauth` variant of `ConfluentAuth`, with a closure
 * over the right plane's getter:
 *
 * | Surface                           | Plane | Closure                                    |
 * | --------------------------------- | ----- | ------------------------------------------ |
 * | cloud / tableflow / telemetry     | CP    | `() => oauthHolder.getControlPlaneToken()` |
 * | flink / schemaRegistry / kafka    | DP    | `() => oauthHolder.getDataPlaneToken()`    |
 *
 * The closures resolve the token at request time (not at construction time)
 * so they compose cleanly with the concurrent OAuth bootstrap from #279:
 * requests fired before `OAuthHolder.bootstrapPromise` settles return
 * `undefined` and the bearer middleware throws `BearerTokenUnavailableError`.
 *
 * When `oauthHolder` is `undefined`, every surface uses the legacy `api_key`
 * shape derived from its connection block's `auth.key` / `auth.secret`.
 */
export function buildAuthConfigForConnection(
  conn: DirectConnectionConfig,
  oauthHolder?: OAuthHolder,
): ClientManagerConfig["auth"] {
  const cpGetter: (() => string | undefined) | undefined = oauthHolder
    ? () => oauthHolder.getControlPlaneToken()
    : undefined;
  const dpGetter: (() => string | undefined) | undefined = oauthHolder
    ? () => oauthHolder.getDataPlaneToken()
    : undefined;

  const surfaceAuth = (
    apiKeyAuth: { key?: string; secret?: string } | undefined,
    oauthGetter: (() => string | undefined) | undefined,
  ): ConfluentAuth =>
    oauthGetter
      ? { type: "oauth", getToken: oauthGetter }
      : { apiKey: apiKeyAuth?.key, apiSecret: apiKeyAuth?.secret };

  return {
    cloud: surfaceAuth(conn.confluent_cloud?.auth, cpGetter),
    tableflow: surfaceAuth(conn.tableflow?.auth, cpGetter),
    telemetry: surfaceAuth(conn.telemetry?.auth, cpGetter),
    flink: surfaceAuth(conn.flink?.auth, dpGetter),
    schemaRegistry: surfaceAuth(conn.schema_registry?.auth, dpGetter),
    kafka: surfaceAuth(conn.kafka?.auth, dpGetter),
  };
}

/**
 * Constructs a {@link DefaultClientManager} from a single direct connection
 * config. When `oauthHolder` is supplied, per-surface auth is wired via
 * {@link buildAuthConfigForConnection}; behavior is unchanged when it isn't.
 */
export function constructClientManagerForConnection(
  conn: DirectConnectionConfig,
  oauthHolder?: OAuthHolder,
): DefaultClientManager {
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

  return new DefaultClientManager({
    kafka: kafkaClientConfig,
    endpoints: {
      // DefaultClientManager uses this as the Tableflow base URL too (see constructor), so always supply the default.
      cloud: conn.confluent_cloud?.endpoint ?? CONFLUENT_CLOUD_DEFAULT_ENDPOINT,
      flink: conn.flink?.endpoint,
      schemaRegistry: conn.schema_registry?.endpoint,
      kafka: conn.kafka?.rest_endpoint,
      telemetry: conn.telemetry?.endpoint,
    },
    auth: buildAuthConfigForConnection(conn, oauthHolder),
  });
}
