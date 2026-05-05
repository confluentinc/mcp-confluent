/**
 * @fileoverview OAuth (bearer-auth) client manager. Wires Confluent Cloud REST
 * surfaces to bearer tokens supplied by an {@link OAuthHolder}; the cloud REST
 * URL is auto-derived from the Auth0 environment via {@link getCloudRestUrlForEnv}.
 *
 * Inherits the abstract {@link BaseClientManager} and intentionally adds nothing
 * native-Kafka-shaped: no broker client, no SASL, no `KafkaJS` import. Native
 * Kafka methods are missing entirely from the class — a call to e.g.
 * `getAdminClient` is a compile-time error rather than a runtime throw on a
 * stub. Tool handlers that need them narrow the runtime's `BaseClientManager`
 * to a `DirectClientManager` via {@link ServerRuntime.requireDirectClientManager},
 * which (alongside the `hasKafka` predicate that gates those tools off for
 * OAuth connections in the first place) keeps the path closed end-to-end.
 *
 * The Schema Registry SDK is similarly unsupported under OAuth, but its getter
 * is part of `BaseClientManager`'s contract and stays inherited. A call to
 * `getSchemaRegistryClient()` therefore still surfaces at runtime as the base
 * class's existing OAuth-rejection throw — to be revisited once OAuth flows
 * through the SDK.
 */

import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { BaseClientManager } from "@src/confluent/base-client-manager.js";
import { ClientCache } from "@src/confluent/client-cache.js";
import { resolveSchemaRegistryEndpoint } from "@src/confluent/oauth-resource-resolvers.js";
import { getCloudRestUrlForEnv } from "@src/confluent/oauth/auth0-config.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import type { Auth0Environment } from "@src/confluent/oauth/types.js";

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
  async disconnect(): Promise<void> {
    await Promise.allSettled([this.srEndpointResolutionCache.shutdown()]);
  }
}
