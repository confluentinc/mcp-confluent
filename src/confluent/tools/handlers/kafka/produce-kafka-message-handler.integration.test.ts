import { KafkaJS } from "@confluentinc/kafka-javascript";
import { ProduceKafkaMessageHandler } from "@src/confluent/tools/handlers/kafka/produce-kafka-message-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { getTestEnvironmentId } from "@tests/harness/confluent-cloud.js";
import {
  activeConnectionTypes,
  CONNECTION_TYPE_DIRECT_FILTERED_REASON,
  CONNECTION_TYPE_OAUTH_FILTERED_REASON,
  ConnectionType,
} from "@tests/harness/connection-types.js";
import {
  connectTestAdmin,
  getTestClusterId,
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
import { skipIfDisabled } from "@tests/harness/skip-gate.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ProduceKafkaMessageHandler();

describe(
  "produce-kafka-message-handler",
  { tags: [Tag.KAFKA, Tag.REQUIRES_KAFKA_CONFIG] },
  () => {
    // the handler's `kafkaBootstrapOrOAuth` predicate accepts either a direct
    // `kafka.bootstrap_servers` block or an OAuth connection; sibling describes exercise each path

    describe(`with a ${ConnectionType.DIRECT} connection`, () => {
      if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
        it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
        return;
      }
      if (skipIfDisabled(handler, integrationConnection())) {
        return;
      }

      // single shared topic for all transports (cheaper than creating one per transport)
      let admin: KafkaJS.Admin;
      const topic = uniqueName("produce");

      beforeAll(async () => {
        admin = await connectTestAdmin();
        await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] });
      });

      afterAll(async () => {
        await admin.deleteTopics({ topics: [topic] }).catch(() => {
          // teardown-only; a cleanup failure shouldn't fail an already-asserted test
        });
        await admin.disconnect();
      });

      describe.each(activeTransports)("via %s transport", (transport) => {
        let server: StartedServer;

        beforeAll(async () => {
          server = await startServer({ transport });
        });

        afterAll(async () => {
          await server?.stop();
        });

        it("should produce a raw-string message and return a partition+offset delivery report", async () => {
          const result = await server.client.callTool({
            name: ToolName.PRODUCE_MESSAGE,
            arguments: {
              topicName: topic,
              value: { message: `hello from ${transport}` },
            },
          });

          // handler formats each delivery report as:
          //   "Message produced successfully to [Topic: ..., Partition: ..., Offset: ...]"
          const text = textContent(result);
          expect(text).toMatch(/Message produced successfully to \[Topic: /);
          expect(text).toContain(topic);
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
          skipIfDisabled(
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
        // `connectTestAdmin()` builds an api-key kafka client from the direct fixture; gate the
        // OAuth describe on the same predicate the direct describe uses so an OAuth-only CI lane
        // without direct creds skips cleanly instead of crashing in beforeAll
        if (
          skipIfDisabled(
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

        // seed via the api-key-authed admin client; the PRODUCE_MESSAGE call goes via OAuth
        let admin: KafkaJS.Admin;
        const topic = uniqueName("produce-oauth");

        beforeAll(async () => {
          admin = await connectTestAdmin();
          await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] });
        });

        afterAll(async () => {
          await admin.deleteTopics({ topics: [topic] }).catch(() => {
            // teardown-only; a cleanup failure shouldn't fail an already-asserted test
          });
          await admin.disconnect();
        });

        describe.each(activeTransports)("via %s transport", (transport) => {
          let server: StartedServer;

          beforeAll(async () => {
            server = await startOAuthServer({ transport });
          }, 180_000);

          afterAll(async () => {
            await stopOAuthServer(server);
          });

          // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
          it("should produce a raw-string message and return a partition+offset delivery report", async () => {
            const result = await callToolWithOAuthFlow(server, credentials, {
              name: ToolName.PRODUCE_MESSAGE,
              arguments: {
                topicName: topic,
                value: { message: `hello from oauth ${transport}` },
                cluster_id: clusterId,
                environment_id: environmentId,
              },
            });

            const text = textContent(result);
            expect(text).toMatch(/Message produced successfully to \[Topic: /);
            expect(text).toContain(topic);
          });
        });
      },
    );
  },
);
