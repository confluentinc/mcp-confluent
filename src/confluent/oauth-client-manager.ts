/**
 * @fileoverview OAuth (bearer-auth) client manager. Wires Confluent Cloud
 * REST surfaces, native Kafka admin/producer/consumer (via KafkaJS +
 * SASL/OAUTHBEARER), and the Schema Registry SDK to bearer tokens supplied
 * by an {@link OAuthHolder}. REST endpoint URLs and Kafka bootstrap servers
 * are resolved at call time from the Auth0 environment + cluster IDs the
 * agent supplies as tool args.
 *
 * The Kafka `oauthBearerProvider` closure reads the holder's current
 * data-plane token at every SASL refresh, so rotation is transparent to
 * cached admin/producer clients. The SR SDK accessor (per-call build) bakes
 * the current DPAT into the SDK's axios headers — no caching, so token
 * staleness is impossible.
 *
 * Schema Registry serialization under OAuth is wired at the manager level
 * but not yet exposed through the produce/consume tools — those handlers
 * return a clear "not yet supported" error. The accessor + endpoint cache
 * stay in place ready for the follow-up PR that adds the discovery tool
 * (`list-schema-registry-clusters`).
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
 * Idle-timeout for cached native Kafka admin/producer clients. After this
 * window of inactivity the cache evicts and disconnects the underlying
 * librdkafka client. 10 minutes was chosen as a reasonable balance between
 * reclaiming socket resources and avoiding the OAuth cold-start cost on
 * every tool call.
 */
const KAFKA_CLIENT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Lifetime hint passed back to librdkafka in the OAUTHBEARER provider
 * response. librdkafka uses this to schedule its next token-refresh callback;
 * 10 minutes lines up with CCloud's typical DPAT lifetime.
 */
const OAUTHBEARER_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

/**
 * Cold-start absorption: the first admin op against a fresh OAuth Kafka
 * connection routinely hangs the full request timeout while CCloud
 * server-side validates the JWT + resolves the principal's RBAC. We expect
 * this first attempt to fail and retry once with a longer timeout; the
 * second attempt rides the now-warm broker session and completes in ms.
 */
const WARMUP_FIRST_ATTEMPT_TIMEOUT_MS = 5_000;
const WARMUP_RETRY_TIMEOUT_MS = 30_000;

/**
 * Bearer-auth client manager. Wires every REST surface to the OAuth holder's
 * tokens — control plane (cloud / tableflow / telemetry) reads
 * {@link OAuthHolder.getControlPlaneToken}; data plane (flink / schema-registry
 * REST / kafka REST) reads {@link OAuthHolder.getDataPlaneToken}. Cloud REST
 * URL is auto-derived from the Auth0 env; data-plane endpoints are resolved
 * at call time via the cmk/srcm REST APIs, then cached per-cluster.
 */
export class OAuthClientManager extends BaseClientManager {
  private readonly holder: OAuthHolder;
  private readonly srEndpointResolutionCache = new ClientCache<
    string,
    string
  >();
  private readonly kafkaAdminCache = new ClientCache<string, KafkaJS.Admin>({
    idleTimeoutMs: KAFKA_CLIENT_IDLE_TIMEOUT_MS,
    dispose: (admin) => admin.disconnect(),
  });
  private readonly kafkaProducerCache = new ClientCache<
    string,
    KafkaJS.Producer
  >({
    idleTimeoutMs: KAFKA_CLIENT_IDLE_TIMEOUT_MS,
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
      try {
        // Cold-start absorption: the first admin op against a freshly-connected
        // OAUTHBEARER session against CCloud routinely hangs the full request
        // timeout — most likely the broker performing first-time JWT signature
        // verification + principal/RBAC lookup (via CCloud's identity service)
        // before responding. After that completes, the principal is cached
        // server-side and subsequent ops are fast. We absorb that first slow
        // call here so the user's first real request lands on the warm
        // session. Producer and consumer paths do NOT yet have an analogous
        // warmup — see follow-up in the PR description.
        try {
          await admin.listTopics({ timeout: WARMUP_FIRST_ATTEMPT_TIMEOUT_MS });
        } catch {
          // Expected on first call against a cold cluster + OAuth principal.
          // Retry with a longer timeout — by now the broker has finished
          // validating and the response should arrive promptly.
          logger.debug(
            { clusterId },
            "[oauth-kafka] warming OAuth admin connection (first metadata fetch timed out as expected)",
          );
          await admin.listTopics({ timeout: WARMUP_RETRY_TIMEOUT_MS });
        }
        return admin;
      } catch (err) {
        // Warmup retry also failed — this is a real problem (auth denial,
        // network unreachable, etc.). Disconnect the half-built admin so we
        // don't leak the broker connection, then propagate the error so the
        // cache evicts and a future call can retry from scratch.
        await admin.disconnect().catch(() => undefined);
        throw err;
      }
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
            lifetime: Date.now() + OAUTHBEARER_TOKEN_LIFETIME_MS,
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
