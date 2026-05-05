/**
 * @fileoverview Abstract {@link BaseClientManager} that owns every Confluent Cloud
 * REST client and the Schema Registry SDK client. Concrete subclasses live in
 * sibling files ({@link DirectClientManager} for api-key auth + native Kafka,
 * plus the OAuth variant introduced in the OAuth wiring ticket).
 */

import type { ClientConfig } from "@confluentinc/schemaregistry";
import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import {
  type ConfluentCloudRestClientManager,
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
import createClient, { Client } from "openapi-fetch";

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
 * Holds every Confluent Cloud REST client (cloud, tableflow, flink, schema-registry REST,
 * kafka REST, telemetry) and the Schema Registry SDK client. Does not own a native Kafka
 * broker client — subclasses add that when they need one.
 */
export abstract class BaseClientManager
  implements ConfluentCloudRestClientManager, SchemaRegistryClientHandler
{
  private confluentCloudBaseUrl: string | undefined;
  private confluentCloudTableflowBaseUrl: string | undefined;
  private confluentCloudFlinkBaseUrl: string | undefined;
  private confluentCloudSchemaRegistryBaseUrl: string | undefined;
  private confluentCloudKafkaRestBaseUrl: string | undefined;
  private confluentCloudTelemetryBaseUrl: string | undefined;
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

  constructor(config: BaseClientManagerConfig) {
    this.confluentCloudBaseUrl = config.endpoints.cloud;
    this.confluentCloudTableflowBaseUrl = config.endpoints.cloud; // at the time of writing, apis are exposed on the same base url as confluent cloud
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
          "Schema Registry OAuth authentication requires the cluster-aware accessor: " +
            "call getSchemaRegistrySdkClient(clusterId, envId) instead. The no-arg " +
            "getSchemaRegistryClient() does not have access to the logical SR cluster ID " +
            "(needed for the target-sr-cluster header) under OAuth.",
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
  getSchemaRegistryClient(): SchemaRegistryClient {
    return this.schemaRegistryClient.get();
  }

  /**
   * Cluster-aware Schema Registry SDK client accessor. Under direct, args are
   * ignored and the existing single-instance Lazy is returned. Under OAuth,
   * args are required: `clusterId` is `lsrc-...` and `envId` is `env-...`. The
   * SR client itself is built per-call (no cache) because the DPAT is captured
   * in the SDK's axios headers at construction time. Endpoint resolution is
   * cached in `OAuthClientManager`.
   */
  async getSchemaRegistrySdkClient(
    _clusterId?: string,
    _envId?: string,
  ): Promise<SchemaRegistryClient> {
    return this.getSchemaRegistryClient();
  }

  abstract disconnect(): Promise<void>;
}
