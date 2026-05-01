/**
 * @fileoverview OAuth (bearer-auth) client manager. Wires Confluent Cloud REST
 * surfaces to bearer tokens supplied by an {@link OAuthHolder}; the cloud REST
 * URL is auto-derived from the Auth0 environment via {@link getCloudRestUrlForEnv}.
 * No native Kafka client — those tools are gated off by the `hasKafka` predicate
 * (the synthesized OAuth connection has no `kafka` block); the Kafka methods
 * below throw defensively if they're ever reached.
 */

import { KafkaJS } from "@confluentinc/kafka-javascript";
import { SchemaRegistryClient } from "@confluentinc/schemaregistry";
import { BaseClientManager } from "@src/confluent/base-client-manager.js";
import { type ClientManager } from "@src/confluent/client-manager.js";
import { getCloudRestUrlForEnv } from "@src/confluent/oauth/auth0-config.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import type { Auth0Environment } from "@src/confluent/oauth/types.js";

const NO_NATIVE_KAFKA_UNDER_OAUTH =
  "Native Kafka client is not available under OAuth authentication";

const NO_SR_SDK_UNDER_OAUTH =
  "Schema Registry SDK client is not available under OAuth authentication. " +
  "Use the Schema Registry REST client (`getConfluentCloudSchemaRegistryRestClient`) instead.";

/**
 * Bearer-auth client manager. Wires every REST surface to the OAuth holder's
 * tokens — control plane (cloud / tableflow / telemetry) reads
 * {@link OAuthHolder.getControlPlaneToken}; data plane (flink / schema-registry
 * REST / kafka REST) reads {@link OAuthHolder.getDataPlaneToken}. Cloud REST URL
 * is auto-derived from the Auth0 env; data-plane endpoints stay unset until T4
 * introduces per-endpoint resolution, and their lazy clients throw at first
 * access if a tool somehow gets enabled with one missing.
 */
export class OAuthClientManager
  extends BaseClientManager
  implements ClientManager
{
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
  getKafkaClient(): KafkaJS.Kafka {
    throw new Error(NO_NATIVE_KAFKA_UNDER_OAUTH);
  }

  /** @inheritdoc */
  async getAdminClient(): Promise<KafkaJS.Admin> {
    throw new Error(NO_NATIVE_KAFKA_UNDER_OAUTH);
  }

  /** @inheritdoc */
  async getProducer(): Promise<KafkaJS.Producer> {
    throw new Error(NO_NATIVE_KAFKA_UNDER_OAUTH);
  }

  /** @inheritdoc */
  async getConsumer(): Promise<KafkaJS.Consumer> {
    throw new Error(NO_NATIVE_KAFKA_UNDER_OAUTH);
  }

  /**
   * Override the inherited SDK getter so the OAuth-specific error reaches callers
   * — `BaseClientManager`'s default message tells users to set
   * `SCHEMA_REGISTRY_API_KEY`/`SECRET`, which is misleading inside an OAuth flow.
   */
  override getSchemaRegistryClient(): SchemaRegistryClient {
    throw new Error(NO_SR_SDK_UNDER_OAUTH);
  }

  /** @inheritdoc */
  async disconnect(): Promise<void> {
    // No native Kafka client to clean up; REST clients have no disconnect.
  }
}
