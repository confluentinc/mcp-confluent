/**
 * @fileoverview Abstract {@link BaseClientManager} that owns every Confluent Cloud
 * REST client and the Schema Registry SDK client. Concrete subclasses live in
 * sibling files ({@link DirectClientManager} for api-key auth + native Kafka,
 * plus the OAuth variant introduced in the OAuth wiring ticket).
 */

import type { KafkaJS } from "@confluentinc/kafka-javascript";
import type { ClientConfig } from "@confluentinc/schemaregistry";
import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import {
  type ConfluentCloudRestClientManager,
  type ConfluentRestClient,
  type SchemaRegistryClientHandler,
} from "@src/confluent/client-manager.js";
import {
  ConfluentAuth,
  ConfluentEndpoints,
  createAuthMiddleware,
} from "@src/confluent/middleware.js";
import { paths } from "@src/confluent/openapi-schema.js";
import { Lazy } from "@src/lazy.js";
import { logger } from "@src/logger.js";
import createClient from "openapi-fetch";

export interface BaseClientManagerConfig {
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
 * Holds every Confluent Cloud REST client (cloud, tableflow, flink,
 * schema-registry REST, kafka REST, telemetry) and the Schema Registry SDK
 * client. Native Kafka admin/producer/consumer clients are declared abstract
 * here so subclasses can supply the implementation that fits their auth model:
 * api-key + SASL/PLAIN in {@link DirectClientManager}, or DPAT +
 * SASL/OAUTHBEARER in OAuthClientManager.
 *
 * The `getSchemaRegistrySdkClient(envId?)` accessor has a default
 * implementation that delegates to the no-arg `getSchemaRegistryClient()`.
 * That covers direct connections (the arg is ignored). OAuth subclasses
 * override it to auto-resolve the SR cluster from the supplied environment
 * id (single SR per environment is the CCloud invariant) and build a
 * bearer-authenticated SDK client per call.
 */
export abstract class BaseClientManager
  implements ConfluentCloudRestClientManager, SchemaRegistryClientHandler
{
  private confluentCloudBaseUrl: string | undefined;
  private confluentCloudFlinkBaseUrl: string | undefined;
  private confluentCloudSchemaRegistryBaseUrl: string | undefined;
  private confluentCloudKafkaRestBaseUrl: string | undefined;
  private confluentCloudTelemetryBaseUrl: string | undefined;
  private readonly confluentCloudFlinkRestClient: Lazy<ConfluentRestClient>;
  private readonly confluentCloudRestClient: Lazy<ConfluentRestClient>;
  private readonly confluentCloudTableflowRestClient: Lazy<ConfluentRestClient>;
  private readonly confluentCloudSchemaRegistryRestClient: Lazy<ConfluentRestClient>;
  private readonly confluentCloudKafkaRestClient: Lazy<ConfluentRestClient>;
  private readonly confluentCloudTelemetryRestClient: Lazy<ConfluentRestClient>;
  private readonly schemaRegistryClient: Lazy<SchemaRegistryClient>;

  constructor(config: BaseClientManagerConfig) {
    this.confluentCloudBaseUrl = config.endpoints.cloud;
    this.confluentCloudFlinkBaseUrl = config.endpoints.flink;
    this.confluentCloudSchemaRegistryBaseUrl = config.endpoints.schemaRegistry;
    this.confluentCloudKafkaRestBaseUrl = config.endpoints.kafka;
    this.confluentCloudTelemetryBaseUrl = config.endpoints.telemetry;

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
      if (!this.confluentCloudBaseUrl) {
        throw new Error(
          "Confluent Cloud Tableflow REST endpoint not configured",
        );
      }
      logger.info(
        `Initializing Confluent Cloud Tableflow REST client for base URL ${this.confluentCloudBaseUrl}`,
      );
      const client = createClient<paths>({
        baseUrl: this.confluentCloudBaseUrl,
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
          "Schema Registry OAuth authentication requires the cluster-aware accessor: " +
            "call getSchemaRegistrySdkClient(envId) instead. The no-arg " +
            "getSchemaRegistryClient() does not have access to the logical SR cluster ID " +
            "(needed for the target-sr-cluster header) under OAuth; the cluster is " +
            "auto-resolved from envId.",
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
  getConfluentCloudFlinkRestClient(): ConfluentRestClient {
    return this.confluentCloudFlinkRestClient.get();
  }

  /** @inheritdoc */
  getConfluentCloudRestClient(): ConfluentRestClient {
    return this.confluentCloudRestClient.get();
  }

  /** @inheritdoc */
  getConfluentCloudTableflowRestClient(): ConfluentRestClient {
    return this.confluentCloudTableflowRestClient.get();
  }

  /** @inheritdoc */
  getConfluentCloudSchemaRegistryRestClient(): ConfluentRestClient {
    return this.confluentCloudSchemaRegistryRestClient.get();
  }

  /** @inheritdoc */
  async getSchemaRegistryRestClient(
    _envId?: string,
  ): Promise<ConfluentRestClient> {
    return this.confluentCloudSchemaRegistryRestClient.get();
  }

  /** @inheritdoc */
  async getConfluentCloudKafkaRestClient(
    _clusterId?: string,
    _envId?: string,
  ): Promise<ConfluentRestClient> {
    return this.confluentCloudKafkaRestClient.get();
  }

  /** @inheritdoc */
  getConfluentCloudTelemetryRestClient(): ConfluentRestClient {
    return this.confluentCloudTelemetryRestClient.get();
  }

  /** @inheritdoc */
  getSchemaRegistryClient(): SchemaRegistryClient {
    return this.schemaRegistryClient.get();
  }

  /**
   * Environment-aware Schema Registry SDK client accessor. Under direct, the
   * arg is ignored and the existing single-instance Lazy is returned. Under
   * OAuth, `envId` (`env-...`) is required; the SR cluster (`lsrc-...`) is
   * auto-resolved from the environment (single SR per environment is the
   * CCloud invariant). The SR client itself is built per-call (no cache)
   * because the DPAT is captured in the SDK's axios headers at construction
   * time; endpoint resolution happens fresh on every call too.
   */
  async getSchemaRegistrySdkClient(
    _envId?: string,
  ): Promise<SchemaRegistryClient> {
    return this.getSchemaRegistryClient();
  }

  /**
   * Cluster-aware Kafka admin client. Under direct, args are ignored and the
   * manager-owned `AsyncLazy` singleton admin is returned (manager controls
   * its lifetime). Under OAuth, args are required and a fresh admin is built
   * per call — the caller owns the lifetime and must dispose via
   * `disposeIfOAuth(runtime, connId, admin)` in a `try { ... } finally { ... }`
   * block (helper at `@src/confluent/tools/cluster-arg-resolvers.js`).
   */
  abstract getKafkaAdminClient(
    clusterId?: string,
    envId?: string,
  ): Promise<KafkaJS.Admin>;

  /**
   * Cluster-aware Kafka producer. Same direct/OAuth lifecycle asymmetry as
   * {@link getKafkaAdminClient}.
   */
  abstract getKafkaProducer(
    clusterId?: string,
    envId?: string,
  ): Promise<KafkaJS.Producer>;

  /**
   * Build a fresh Kafka consumer (per-call on both direct and OAuth — group
   * membership has its own server-side lifecycle that doesn't compose with
   * cached clients). The returned consumer is unconnected; the caller must
   * call `connect()` and `disconnect()` (typically in a `try/finally`).
   */
  abstract buildKafkaConsumer(
    opts?: ConsumerBuildOptions,
  ): Promise<KafkaJS.Consumer>;

  abstract disconnect(): Promise<void>;
}

/**
 * Per-call options for {@link BaseClientManager.buildKafkaConsumer}. All
 * fields are optional; each concrete manager validates only what its auth
 * model requires (e.g. OAuth needs `clusterId` + `envId`, direct ignores
 * both).
 */
export interface ConsumerBuildOptions {
  /**
   * Confluent Cloud logical Kafka cluster id (`lkc-...`). Required for
   * OAuth (used to resolve the SASL/OAUTHBEARER bootstrap endpoint);
   * ignored on direct (the bootstrap comes from connection config).
   */
  clusterId?: string;
  /**
   * Confluent Cloud environment id (`env-...`) that owns the cluster.
   * Required for OAuth; ignored on direct.
   */
  envId?: string;
  /**
   * Consumer group identifier. On direct, appended as a suffix to the
   * configured base group.id so concurrent MCP sessions don't share a
   * group. On OAuth, used as the literal group id.
   */
  groupId?: string;
  /**
   * Reset policy for the consumer. Defaults to `"earliest"` when the
   * caller omits it. Handlers that derive the value from per-call inputs
   * (e.g. `consume-messages`, which inspects each topic entry's `start`
   * field) pass it explicitly. Maps straight to librdkafka
   * `auto.offset.reset`.
   */
  offsetReset?: "earliest" | "latest";
}
