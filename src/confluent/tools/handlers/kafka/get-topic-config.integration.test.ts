import { GetTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/get-topic-config.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { getTestEnvironmentId } from "@tests/harness/confluent-cloud.js";
import {
  activeConnectionTypes,
  CONNECTION_TYPE_DIRECT_FILTERED_REASON,
  CONNECTION_TYPE_OAUTH_FILTERED_REASON,
  ConnectionType,
} from "@tests/harness/connection-types.js";
import {
  getTestClusterId,
  withSharedAdminClient,
} from "@tests/harness/kafka-admin.js";
import {
  callToolWithOAuthFlow,
  DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON,
  getOAuthCredentialsFromEnv,
  OAUTH_FIXTURE_NOT_LOADED_REASON,
  OAUTH_USER_CREDS_MISSING_REASON,
  startOAuthServer,
  stopOAuthServer,
} from "@tests/harness/oauth-flow.js";
import { integrationConnection } from "@tests/harness/runtime.js";
import { skipIfNotEnabled } from "@tests/harness/skip-gate.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new GetTopicConfigHandler();

describe(
  "get-topic-config",
  { tags: [Tag.KAFKA, Tag.REQUIRES_KAFKA_CONFIG] },
  () => {
    // the handler's `kafkaRestWithAuthOrOAuth` predicate accepts either a direct
    // `kafka.rest_endpoint + kafka.auth` block or an OAuth connection; sibling describes exercise each path

    describe(`with a ${ConnectionType.DIRECT} connection`, () => {
      if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
        it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
        return;
      }
      if (skipIfNotEnabled(handler, integrationConnection())) {
        return;
      }

      const clusterId = getTestClusterId();
      // installs beforeAll/afterAll at this describe scope (shared admin client, topic cleanup)
      const { admin, createdTopics } = withSharedAdminClient();

      describe.each(activeTransports)("via %s transport", (transport) => {
        let server: StartedServer;

        beforeAll(async () => {
          server = await startServer({ transport });
        });

        afterAll(async () => {
          await server?.stop();
        });

        it("should return the topic configuration for an existing topic", async () => {
          const topic = uniqueName(`get-config-${transport}`);
          createdTopics.push(topic);
          await admin().createTopics({ topics: [{ topic, numPartitions: 1 }] });

          const result = await server.client.callTool({
            name: ToolName.GET_TOPIC_CONFIG,
            arguments: {
              clusterId,
              topicName: topic,
            },
          });

          // handler embeds a JSON blob with both topicDetails and topicConfig
          const text = textContent(result);
          expect(text).toContain(`Topic configuration for '${topic}'`);
          expect(text).toContain("topicDetails");
          expect(text).toContain("topicConfig");
        });
      });
    });

    describe(
      `with a ${ConnectionType.OAUTH} connection`,
      { tags: [Tag.OAUTH] },
      () => {
        if (!activeConnectionTypes.includes(ConnectionType.OAUTH)) {
          it.skip(CONNECTION_TYPE_OAUTH_FILTERED_REASON, () => {});
          return;
        }
        if (
          skipIfNotEnabled(
            handler,
            integrationConnection({ oauth: true }),
            OAUTH_FIXTURE_NOT_LOADED_REASON,
          )
        ) {
          return;
        }
        const credentials = getOAuthCredentialsFromEnv();
        if (!credentials) {
          it.skip(OAUTH_USER_CREDS_MISSING_REASON, () => {});
          return;
        }
        // `getTestClusterId()`/`withSharedAdminClient()` read api-key kafka config from the direct
        // fixture; gate the OAuth describe on the same predicate the direct describe uses so an
        // OAuth-only CI lane without direct creds skips cleanly instead of crashing in beforeAll
        if (
          skipIfNotEnabled(
            handler,
            integrationConnection(),
            DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON,
          )
        ) {
          return;
        }

        // REST-tool handler resolves the cluster URL from `clusterId` + `environmentId` at call
        // time under OAuth (no `kafka.rest_endpoint` in OAuth connections); the handler errors
        // when either is omitted
        const clusterId = getTestClusterId();
        const environmentId = getTestEnvironmentId();
        // seed via the api-key-authed admin client; GET_TOPIC_CONFIG goes via OAuth
        const { admin, createdTopics } = withSharedAdminClient();

        describe.each(activeTransports)("via %s transport", (transport) => {
          let server: StartedServer;

          beforeAll(async () => {
            server = await startOAuthServer({ transport });
          }, 180_000);

          afterAll(async () => {
            await stopOAuthServer(server);
          });

          // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
          it("should return the topic configuration for an existing topic", async () => {
            const topic = uniqueName(`get-config-oauth-${transport}`);
            createdTopics.push(topic);
            await admin().createTopics({
              topics: [{ topic, numPartitions: 1 }],
            });

            const result = await callToolWithOAuthFlow(server, credentials, {
              name: ToolName.GET_TOPIC_CONFIG,
              arguments: {
                clusterId,
                environmentId,
                topicName: topic,
              },
            });

            const text = textContent(result);
            expect(text).toContain(`Topic configuration for '${topic}'`);
            expect(text).toContain("topicDetails");
            expect(text).toContain("topicConfig");
          });
        });
      },
    );
  },
);
