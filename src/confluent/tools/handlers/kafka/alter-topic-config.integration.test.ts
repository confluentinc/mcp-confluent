import { AlterTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/alter-topic-config.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
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
  getOAuthCredentialsFromEnv,
  OAUTH_FIXTURE_NOT_LOADED_REASON,
  OAUTH_USER_CREDS_MISSING_REASON,
  startOAuthServer,
  stopOAuthServer,
} from "@tests/harness/oauth-flow.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new AlterTopicConfigHandler();

describe("alter-topic-config", { tags: [Tag.KAFKA] }, () => {
  // the handler's `kafkaRestWithAuthOrOAuth` predicate accepts either a direct
  // `kafka.rest_endpoint + kafka.auth` block or an OAuth connection; sibling describes exercise each path

  describe(`with a ${ConnectionType.DIRECT} connection`, () => {
    if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
      it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
      return;
    }
    const directRuntime = integrationRuntime({ oauth: false });
    if (handler.enabledConnectionIds(directRuntime).length === 0) {
      it.skip("requires kafka.rest_endpoint + kafka.auth in test-fixtures/yaml_configs/integration.yaml", () => {});
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

      it("should alter retention.ms on the test topic via the REST proxy", async () => {
        const topic = uniqueName(`alter-${transport}`);
        createdTopics.push(topic);
        await admin().createTopics({ topics: [{ topic, numPartitions: 1 }] });

        const result = await server.client.callTool({
          name: ToolName.ALTER_TOPIC_CONFIG,
          arguments: {
            clusterId,
            topicName: topic,
            topicConfigs: [
              {
                name: "retention.ms",
                value: "3600000",
                operation: "SET",
              },
            ],
            validateOnly: false,
          },
        });

        expect(textContent(result)).toMatch(
          /Successfully altered topic config/,
        );
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
      const oauthRuntime = integrationRuntime({ oauth: true });
      if (handler.enabledConnectionIds(oauthRuntime).length === 0) {
        it.skip(OAUTH_FIXTURE_NOT_LOADED_REASON, () => {});
        return;
      }
      const credentials = getOAuthCredentialsFromEnv();
      if (!credentials) {
        it.skip(OAUTH_USER_CREDS_MISSING_REASON, () => {});
        return;
      }

      const clusterId = getTestClusterId();
      // seed via the api-key-authed admin client; ALTER_TOPIC_CONFIG goes via OAuth
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
        it("should alter retention.ms on the test topic via the REST proxy", async () => {
          const topic = uniqueName(`alter-oauth-${transport}`);
          createdTopics.push(topic);
          await admin().createTopics({ topics: [{ topic, numPartitions: 1 }] });

          const result = await callToolWithOAuthFlow(server, credentials, {
            name: ToolName.ALTER_TOPIC_CONFIG,
            arguments: {
              clusterId,
              topicName: topic,
              topicConfigs: [
                {
                  name: "retention.ms",
                  value: "3600000",
                  operation: "SET",
                },
              ],
              validateOnly: false,
            },
          });

          expect(textContent(result)).toMatch(
            /Successfully altered topic config/,
          );
        });
      });
    },
  );
});
