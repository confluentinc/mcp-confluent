/**
 * @fileoverview OAuth (bearer-auth) client manager. Wires Confluent Cloud REST
 * surfaces to bearer tokens supplied by an {@link OAuthHolder}; the cloud REST
 * URL is auto-derived from the Auth0 environment via {@link getCloudRestUrlForEnv}.
 *
 * Inherits the abstract {@link BaseClientManager} and implements cluster-aware
 * native Kafka accessors backed by {@link KafkaJS} with an `oauthBearerProvider`
 * closure that reads the holder's current data-plane token at auth time, making
 * token rotation transparent to cached clients.
 *
 * The Schema Registry SDK is similarly unsupported under OAuth, but its getter
 * is part of `BaseClientManager`'s contract and stays inherited. A call to
 * `getSchemaRegistryClient()` therefore still surfaces at runtime as the base
 * class's existing OAuth-rejection throw — to be revisited once OAuth flows
 * through the SDK.
 */

import type { KafkaJS } from "@confluentinc/kafka-javascript";
import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { BaseClientManager } from "@src/confluent/base-client-manager.js";
import { ClientCache } from "@src/confluent/client-cache.js";
import { kafkaDeps } from "@src/confluent/node-deps.js";
import {
  resolveKafkaBootstrap,
  resolveSchemaRegistryEndpoint,
} from "@src/confluent/oauth-resource-resolvers.js";
import { getCloudRestUrlForEnv } from "@src/confluent/oauth/auth0-config.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import type { Auth0Environment } from "@src/confluent/oauth/types.js";
import { kafkaLogger, logger } from "@src/logger.js";

/**
 * Bearer-auth client manager. Wires every REST surface to the OAuth holder's
 * tokens — control plane (cloud / tableflow / telemetry) reads
 * {@link OAuthHolder.getControlPlaneToken}; data plane (flink / schema-registry
 * REST / kafka REST) reads {@link OAuthHolder.getDataPlaneToken}. Cloud REST URL
 * is auto-derived from the Auth0 env; data-plane endpoints stay unset until T4
 * introduces per-endpoint resolution, and their lazy clients throw at first
 * access if a tool somehow gets enabled with one missing.
 */
export class OAuthClientManager extends BaseClientManager {
  private readonly holder: OAuthHolder;
  private readonly srEndpointResolutionCache = new ClientCache<
    string,
    string
  >();
  private readonly kafkaAdminCache = new ClientCache<string, KafkaJS.Admin>({
    idleTimeoutMs: 10 * 60 * 1000,
    dispose: (admin) => admin.disconnect(),
  });
  private readonly kafkaProducerCache = new ClientCache<
    string,
    KafkaJS.Producer
  >({
    idleTimeoutMs: 10 * 60 * 1000,
    dispose: (producer) => producer.disconnect(),
  });
  private readonly bootstrapResolutionCache = new ClientCache<string, string>();

  constructor(holder: OAuthHolder, env: Auth0Environment) {
    const cpToken = (): string | undefined => holder.getControlPlaneToken();
    const dpToken = (): string | undefined => holder.getDataPlaneToken();
    super({
      endpoints: {
        // BaseClientManager re-uses `cloud` for the Tableflow base URL too.
        cloud: getCloudRestUrlForEnv(env),
        flink: undefined,
        schemaRegistry: undefined,
        kafka: undefined,
        telemetry: undefined,
      },
      auth: {
        cloud: { type: "oauth", getToken: cpToken },
        tableflow: { type: "oauth", getToken: cpToken },
        telemetry: { type: "oauth", getToken: cpToken },
        flink: { type: "oauth", getToken: dpToken },
        schemaRegistry: { type: "oauth", getToken: dpToken },
        kafka: { type: "oauth", getToken: dpToken },
      },
    });

    this.holder = holder;

    // Eager construction: surface the cloud REST client at startup so a bad
    // endpoint or middleware wiring fails fast rather than at first tool call.
    this.getConfluentCloudRestClient();
  }

  /** @inheritdoc */
  async getSchemaRegistrySdkClient(
    clusterId?: string,
    envId?: string,
  ): Promise<SchemaRegistryClient> {
    if (clusterId === undefined || envId === undefined) {
      throw new Error(
        "cluster_id and environment_id are required under --oauth for Schema Registry SDK access. " +
          "Call list-schema-registry-clusters and pass the cluster's `id` plus the environment_id.",
      );
    }
    const endpoint = await this.srEndpointResolutionCache.get(clusterId, () =>
      resolveSchemaRegistryEndpoint(
        this.getConfluentCloudRestClient(),
        clusterId,
        envId,
      ),
    );
    const dpat = this.holder.getDataPlaneToken() ?? "";
    return new SchemaRegistryClient({
      baseURLs: [endpoint],
      createAxiosDefaults: {
        headers: {
          Authorization: `Bearer ${dpat}`,
          "target-sr-cluster": clusterId,
        },
      },
    });
  }

  /** @inheritdoc */
  async getKafkaAdminClient(
    clusterId?: string,
    envId?: string,
  ): Promise<KafkaJS.Admin> {
    if (clusterId === undefined || envId === undefined) {
      throw new Error(
        "cluster_id and environment_id are required under --oauth for native Kafka access. " +
          "Call list-clusters with environment_id and pass the cluster's `id` and `spec.environment.id`.",
      );
    }
    return this.kafkaAdminCache.get(clusterId, async () => {
      const kafka = await this.buildOAuthKafkaClient(clusterId, envId);
      const admin = kafka.admin();
      await admin.connect();
      // Workaround: the first admin op against a freshly-connected OAUTHBEARER
      // session reliably hangs to the request timeout — the kafkaJS-compat
      // wrapper's async `oauthBearerProvider` races librdkafka's SASL state
      // machine, the broker never receives a valid bearer token, and both sides
      // wait silently. The timeout itself resets librdkafka's connection state;
      // the *second* op authenticates fast. We absorb that first failure here,
      // with a short bounded timeout, so the user's first real request lands on
      // the warm second connection. If even the second metadata fetch fails,
      // surface the error — it's no longer a race, it's a real problem.
      try {
        await admin.listTopics({ timeout: 5_000 });
      } catch (firstErr) {
        logger.info(
          {
            clusterId,
            err:
              firstErr instanceof Error ? firstErr.message : String(firstErr),
          },
          "[oauth-kafka] first metadata fetch failed (expected); retrying to warm connection",
        );
        await admin.listTopics({ timeout: 30_000 });
      }
      return admin;
    });
  }

  /** @inheritdoc */
  async getKafkaProducer(
    clusterId?: string,
    envId?: string,
  ): Promise<KafkaJS.Producer> {
    if (clusterId === undefined || envId === undefined) {
      throw new Error(
        "cluster_id and environment_id are required under --oauth for native Kafka access.",
      );
    }
    return this.kafkaProducerCache.get(clusterId, async () => {
      const kafka = await this.buildOAuthKafkaClient(clusterId, envId);
      const producer = kafka.producer();
      await producer.connect();
      return producer;
    });
  }

  /** @inheritdoc */
  async buildKafkaConsumer(
    clusterId?: string,
    envId?: string,
    groupId?: string,
  ): Promise<KafkaJS.Consumer> {
    if (clusterId === undefined || envId === undefined) {
      throw new Error(
        "cluster_id and environment_id are required under --oauth for native Kafka access.",
      );
    }
    const kafka = await this.buildOAuthKafkaClient(clusterId, envId);
    return kafka.consumer({
      kafkaJS: {
        groupId: groupId ?? "mcp-confluent",
        autoCommit: false,
        fromBeginning: true,
      },
    });
  }

  private async buildOAuthKafkaClient(
    clusterId: string,
    envId: string,
  ): Promise<KafkaJS.Kafka> {
    // Wait for OAuth login to finish so the data-plane token is populated before
    // librdkafka starts the SASL/OAUTHBEARER handshake. Without this, the provider
    // closure returns an empty token on the first invocation and the broker times
    // out the connection (~60s) instead of failing fast with a clear auth error.
    await this.holder.bootstrapPromise;
    if (!this.holder.getDataPlaneToken()) {
      throw new Error(
        "OAuth login did not produce a data-plane token; cannot connect to Kafka. " +
          "Check the OAuth login flow status (browser sign-in must complete).",
      );
    }
    const bootstrap = await this.bootstrapResolutionCache.get(clusterId, () =>
      resolveKafkaBootstrap(
        this.getConfluentCloudRestClient(),
        clusterId,
        envId,
      ),
    );
    // librdkafka debug logs — gated by env var so they don't pollute normal
    // server stderr. Set OAUTH_KAFKA_DEBUG=security,broker,protocol (or
    // "all") to see the full SASL/OAUTHBEARER handshake and broker traffic.
    // Useful when the first admin op stalls until the request timeout fires
    // instead of failing fast — it usually means librdkafka is waiting on a
    // response that never arrives, and the debug logs show why.
    const debug = process.env.OAUTH_KAFKA_DEBUG;
    return new kafkaDeps.Kafka({
      ...(debug ? { debug } : {}),
      kafkaJS: {
        brokers: [bootstrap],
        ssl: true,
        // Critical for stdio MCP: route KafkaJS / librdkafka logs through pino
        // (which writes to stderr). Without this, the default logger prints to
        // stdout in pretty format, corrupting the stdio JSON-RPC stream and
        // crashing the MCP client with "Unexpected token" parse errors.
        logger: kafkaLogger,
        sasl: {
          mechanism: "oauthbearer",
          oauthBearerProvider: async () => ({
            value: this.holder.getDataPlaneToken() ?? "",
            principal: clusterId,
            lifetime: Date.now() + 10 * 60 * 1000,
            extensions: { logicalCluster: clusterId },
          }),
        },
      },
    });
  }

  /** @inheritdoc */
  async disconnect(): Promise<void> {
    await Promise.allSettled([
      this.kafkaAdminCache.shutdown(),
      this.kafkaProducerCache.shutdown(),
      this.bootstrapResolutionCache.shutdown(),
      this.srEndpointResolutionCache.shutdown(),
    ]);
  }
}
