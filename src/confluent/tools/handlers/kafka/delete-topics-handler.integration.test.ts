import { DeleteTopicsHandler } from "@src/confluent/tools/handlers/kafka/delete-topics-handler.js";
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

const handler = new DeleteTopicsHandler();

describe(
  "delete-topics-handler",
  { tags: [Tag.KAFKA, Tag.REQUIRES_KAFKA_CONFIG] },
  () => {
    // the handler's `kafkaBootstrapOrOAuth` predicate accepts either a direct
    // `kafka.bootstrap_servers` block or an OAuth connection; sibling describes exercise each path

    describe(`with a ${ConnectionType.DIRECT} connection`, () => {
      if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
        it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
        return;
      }
      if (skipIfNotEnabled(handler, integrationConnection())) {
        return;
      }

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

        it("should delete the requested Kafka topic", async () => {
          const topic = uniqueName(`delete-${transport}`);
          createdTopics.push(topic);
          await admin().createTopics({ topics: [{ topic, numPartitions: 1 }] });
          // wait for the newly-created topic to be visible before deleting it
          await expect
            .poll(() => admin().listTopics(), {
              timeout: 15_000,
              interval: 500,
            })
            .toContain(topic);

          const result = await server.client.callTool({
            name: ToolName.DELETE_TOPICS,
            arguments: { topicNames: [topic] },
          });

          expect(result.isError, textContent(result)).not.toBe(true);

          await expect
            .poll(() => admin().listTopics(), {
              timeout: 15_000,
              interval: 500,
            })
            .not.toContain(topic);
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
        // `withSharedAdminClient()` builds an api-key kafka client from the direct fixture; gate
        // the OAuth describe on the same predicate the direct describe uses so an OAuth-only CI
        // lane without direct creds skips cleanly instead of crashing in beforeAll
        if (
          skipIfNotEnabled(
            handler,
            integrationConnection(),
            DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON,
          )
        ) {
          return;
        }

        // OAuth connections carry no `kafka` block, so the handler resolves the broker from
        // `cluster_id` + `environment_id` at call time; under OAuth the handler errors when omitted
        const clusterId = getTestClusterId();
        const environmentId = getTestEnvironmentId();

        // seed + verify via the api-key-authed admin client; only the DELETE_TOPICS call goes via OAuth
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
          it("should delete the requested Kafka topic", async () => {
            const topic = uniqueName(`delete-oauth-${transport}`);
            createdTopics.push(topic);
            await admin().createTopics({
              topics: [{ topic, numPartitions: 1 }],
            });
            await expect
              .poll(() => admin().listTopics(), {
                timeout: 15_000,
                interval: 500,
              })
              .toContain(topic);

            const result = await callToolWithOAuthFlow(server, credentials, {
              name: ToolName.DELETE_TOPICS,
              arguments: {
                topicNames: [topic],
                cluster_id: clusterId,
                environment_id: environmentId,
              },
            });

            expect(result.isError, textContent(result)).not.toBe(true);

            await expect
              .poll(() => admin().listTopics(), {
                timeout: 15_000,
                interval: 500,
              })
              .not.toContain(topic);
          });
        });
      },
    );
  },
);
