/**
 * @fileoverview OAuth (bearer-auth) client manager. Wires Confluent Cloud
 * REST surfaces, native Kafka admin/producer/consumer (via `@confluentinc/kafka-javascript` +
 * SASL/OAUTHBEARER), and the Schema Registry SDK to bearer tokens supplied
 * by an {@link OAuthHolder}. REST endpoint URLs and Kafka bootstrap servers
 * are resolved at call time from the CCloud environment + cluster IDs the
 * agent supplies as tool args.
 *
 * Native Kafka clients are built fresh per call; handlers wrap usage in
 * `try { ... } finally { await disposeIfOAuth(...) }` for caller-owned
 * disposal. SASL/OAUTHBEARER is configured via librdkafka's synchronous
 * token-refresh callback (no kafkaJS-compat async-provider race), so no
 * warmup workaround is needed.
 *
 * Schema Registry serialization under OAuth is wired at the manager level
 * but not yet exposed through the produce/consume tools — those handlers
 * return a clear "not yet supported" error. The accessor + endpoint
 * resolver stay in place ready for the follow-up.
 */

import type { GlobalConfig, KafkaJS } from "@confluentinc/kafka-javascript";
import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { BaseClientManager } from "@src/confluent/base-client-manager.js";
import {
  type ConfluentAuth,
  createAuthMiddleware,
} from "@src/confluent/middleware.js";
import { kafkaDeps } from "@src/confluent/node-deps.js";
import {
  resolveKafkaBootstrap,
  resolveKafkaRestEndpoint,
  resolveSchemaRegistryEndpoint,
} from "@src/confluent/oauth-resource-resolvers.js";
import { getCloudRestUrlForEnv } from "@src/confluent/oauth/auth0-config.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import type { Auth0Environment } from "@src/confluent/oauth/types.js";
import type { paths } from "@src/confluent/openapi-schema.js";
import { kafkaLogger } from "@src/logger.js";
import createClient, { type Client } from "openapi-fetch";
import { DATA_PLANE_TOKEN_LIFETIME_MS } from "./oauth/token-lifetimes.js";

// Lifetime hint passed to librdkafka inside the OAUTHBEARER refresh callback
// — `DATA_PLANE_TOKEN_LIFETIME_MS` is the canonical value (~10min, matching
// CCloud's DPAT lifetime). librdkafka uses this to schedule its next refresh
// callback; within a single tool call only the first invocation matters.

type PostProcessTokenRefresh = (
  err: Error | null,
  token?: {
    tokenValue: string;
    lifetime: number;
    principal: string;
    extensions?: Record<string, string>;
  },
) => void;

/**
 * Bearer-auth client manager. Wires every REST surface to the OAuth holder's
 * tokens — control plane (cloud / tableflow / telemetry) reads
 * {@link OAuthHolder.getControlPlaneToken}; data plane (flink / schema-registry
 * REST / kafka REST) reads {@link OAuthHolder.getDataPlaneToken}. Cloud REST URL
 * is auto-derived from the CCloud env. Native Kafka clients (admin, producer,
 * consumer) are built fresh per call against bootstrap endpoints resolved
 * via the cmk REST API; SASL/OAUTHBEARER is configured via librdkafka's
 * synchronous token-refresh callback to avoid the kafkaJS-compat
 * async-provider race that previously required a warmup workaround.
 */
export class OAuthClientManager extends BaseClientManager {
  private readonly holder: OAuthHolder;

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
    this.requireClusterArgs(clusterId, envId);
    // The SR SDK captures `Authorization: Bearer <token>` in its axios
    // `createAxiosDefaults` at construction time, so a build during initial
    // login or a broken refresh would freeze an empty bearer into every
    // subsequent request — fail fast here before that can happen.
    const dpat = await this.requireDataPlaneToken();
    const endpoint = await resolveSchemaRegistryEndpoint(
      this.getConfluentCloudRestClient(),
      clusterId!,
      envId!,
    );
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
  async getConfluentCloudKafkaRestClient(
    clusterId?: string,
    envId?: string,
  ): Promise<Client<paths, `${string}/${string}`>> {
    this.requireClusterArgs(clusterId, envId);
    // The bearer middleware reads `auth.getToken()` per-request, but failing
    // fast here gives the agent a clear error rather than letting an empty
    // bearer go out on the wire.
    await this.requireDataPlaneToken();
    const baseUrl = await resolveKafkaRestEndpoint(
      this.getConfluentCloudRestClient(),
      clusterId!,
      envId!,
    );
    const auth: ConfluentAuth = {
      type: "oauth",
      getToken: () => this.holder.getDataPlaneToken(),
    };
    const client = createClient<paths>({ baseUrl });
    client.use(createAuthMiddleware(auth));
    return client;
  }

  /** @inheritdoc */
  async getKafkaAdminClient(
    clusterId?: string,
    envId?: string,
  ): Promise<KafkaJS.Admin> {
    this.requireClusterArgs(clusterId, envId);
    const kafka = await this.buildOAuthKafkaClient(clusterId!, envId!);
    const admin = kafka.admin();
    try {
      await admin.connect();
      // Metadata warmup: `admin.connect()` returns before librdkafka has
      // discovered the controller broker. The first non-list operation
      // (createTopics, deleteTopics) needs the controller and times out
      // locally if metadata isn't yet cached. listTopics is a cheap
      // metadata-only roundtrip that primes the broker map; subsequent
      // ops on this admin instance reuse it. Costs ~50-200ms per OAuth
      // admin call; acceptable given clients are per-call by design.
      await admin.listTopics();
      return admin;
    } catch (err) {
      // Disconnect the half-built admin so we don't leak the broker
      // connection on a failed warmup.
      await admin.disconnect().catch(() => undefined);
      throw err;
    }
  }

  /** @inheritdoc */
  async getKafkaProducer(
    clusterId?: string,
    envId?: string,
  ): Promise<KafkaJS.Producer> {
    this.requireClusterArgs(clusterId, envId);
    const kafka = await this.buildOAuthKafkaClient(clusterId!, envId!);
    const producer = kafka.producer();
    await producer.connect();
    return producer;
  }

  /** @inheritdoc */
  async buildKafkaConsumer(
    clusterId?: string,
    envId?: string,
    groupId?: string,
  ): Promise<KafkaJS.Consumer> {
    this.requireClusterArgs(clusterId, envId);
    const kafka = await this.buildOAuthKafkaClient(clusterId!, envId!);
    return kafka.consumer({
      kafkaJS: {
        groupId: groupId ?? "mcp-confluent",
        autoCommit: false,
        fromBeginning: true,
      },
    });
  }

  /** @inheritdoc */
  async disconnect(): Promise<void> {
    // No state to drain — every Kafka client is caller-owned and disposed
    // by the handler's `finally` block via `disposeIfOAuth`.
  }

  /**
   * Awaits the holder's bootstrap promise and returns the current data-plane
   * token, throwing when the bootstrap completes without one. Used by every
   * OAuth-side client accessor to fail fast before constructing a client
   * with an empty bearer.
   */
  private async requireDataPlaneToken(): Promise<string> {
    await this.holder.bootstrapPromise;
    const dpat = this.holder.getDataPlaneToken();
    if (!dpat) {
      throw new Error(
        "OAuth login did not produce a data-plane token. " +
          "Check the OAuth login flow status (browser sign-in must complete).",
      );
    }
    return dpat;
  }

  private requireClusterArgs(
    clusterId: string | undefined,
    envId: string | undefined,
  ): void {
    if (clusterId === undefined || envId === undefined) {
      // Defensive check — handlers should validate arg-name shape and throw
      // their own user-facing error via resolveKafkaClusterArgs (native, snake_case)
      // or resolveKafkaRestArgs (REST, camelCase) before reaching the manager.
      // This message fires only when a caller bypasses those resolvers, so
      // it's worded generically rather than tied to either arg-name convention.
      throw new Error(
        "OAuth client construction requires a cluster id and environment id. " +
          "Discover via list-environments and list-clusters; pass the cluster's `id` and `spec.environment.id`.",
      );
    }
  }

  private async buildOAuthKafkaClient(
    clusterId: string,
    envId: string,
  ): Promise<KafkaJS.Kafka> {
    // Ensure the DPAT is populated before librdkafka starts the SASL
    // handshake — the synchronous `oauthbearer_token_refresh_cb` (configured
    // below) reads it on demand, so an empty token here would surface as a
    // broker-side auth failure with no useful diagnostic.
    await this.requireDataPlaneToken();
    // librdkafka debug logs — gated by env var so they don't pollute normal
    // server stderr. Set OAUTH_KAFKA_DEBUG=security,broker,protocol (or
    // "all") to see the full SASL/OAUTHBEARER handshake and broker traffic.
    const debug = process.env.OAUTH_KAFKA_DEBUG;
    const bootstrap = await resolveKafkaBootstrap(
      this.getConfluentCloudRestClient(),
      clusterId,
      envId,
    );
    const config: GlobalConfig = {
      "bootstrap.servers": bootstrap,
      "security.protocol": "sasl_ssl",
      "sasl.mechanisms": "OAUTHBEARER",
      // Synchronous librdkafka-native refresh callback. Reads the holder's
      // current DPAT and pushes it into librdkafka via postProcessTokenRefresh
      // inline — no async, no microtask race with the SASL state machine.
      oauthbearer_token_refresh_cb: (
        _oauthbearerConfig: string,
        postProcessTokenRefresh: PostProcessTokenRefresh,
      ): void => {
        const dpat = this.holder.getDataPlaneToken();
        if (!dpat) {
          postProcessTokenRefresh(
            new Error("Data-plane token unavailable for SASL refresh"),
          );
          return;
        }
        postProcessTokenRefresh(null, {
          tokenValue: dpat,
          lifetime: Date.now() + DATA_PLANE_TOKEN_LIFETIME_MS,
          principal: clusterId,
          extensions: { logicalCluster: clusterId },
        });
      },
      ...(debug ? { debug } : {}),
    };
    // Critical for stdio MCP: route KafkaJS / librdkafka logs through pino
    // (which writes to stderr). Without this, the default logger prints to
    // stdout in pretty format, corrupting the stdio JSON-RPC stream.
    return new kafkaDeps.Kafka({
      ...config,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      kafkaJS: { logger: kafkaLogger } as any,
    });
  }
}
