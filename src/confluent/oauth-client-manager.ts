/**
 * @fileoverview OAuth (bearer-auth) client manager. Wires Confluent Cloud REST
 * surfaces to bearer tokens supplied by an {@link OAuthHolder}; the cloud REST
 * URL is auto-derived from the Auth0 environment via {@link getCloudRestUrlForEnv}.
 *
 * Inherits the abstract {@link BaseClientManager} and intentionally adds nothing
 * native-Kafka-shaped: no broker client, no SASL, no `KafkaJS`/SR-SDK imports.
 * Native-Kafka tools are gated to direct connections by their predicates and
 * narrow the runtime's `BaseClientManager` to a `DirectClientManager` via
 * {@link ServerRuntime.requireDirectClientManager}, so a missing-on-OAuth
 * Kafka method is a compile-time error rather than a runtime throw.
 */

import { BaseClientManager } from "@src/confluent/base-client-manager.js";
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

    // Eager construction: surface the cloud REST client at startup so a bad
    // endpoint or middleware wiring fails fast rather than at first tool call.
    this.getConfluentCloudRestClient();
  }

  /** @inheritdoc */
  async disconnect(): Promise<void> {
    // No native Kafka client to clean up; REST clients have no disconnect.
  }
}
