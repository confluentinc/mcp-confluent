import { DeleteTopicsHandler } from "@src/confluent/tools/handlers/kafka/delete-topics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  activeConnectionTypes,
  CONNECTION_TYPE_DIRECT_FILTERED_REASON,
  CONNECTION_TYPE_OAUTH_FILTERED_REASON,
  ConnectionType,
} from "@tests/harness/connection-types.js";
import { withSharedAdminClient } from "@tests/harness/kafka-admin.js";
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

const handler = new DeleteTopicsHandler();

describe("delete-topics-handler", { tags: [Tag.KAFKA] }, () => {
  // the handler's `kafkaBootstrapOrOAuth` predicate accepts either a direct
  // `kafka.bootstrap_servers` block or an OAuth connection; sibling describes exercise each path

  describe(`with a ${ConnectionType.DIRECT} connection`, () => {
    if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
      it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
      return;
    }
    const directRuntime = integrationRuntime({ oauth: false });
    if (handler.enabledConnectionIds(directRuntime).length === 0) {
      it.skip("requires kafka.bootstrap_servers in test-fixtures/yaml_configs/integration.yaml", () => {});
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
          await admin().createTopics({ topics: [{ topic, numPartitions: 1 }] });
          await expect
            .poll(() => admin().listTopics(), {
              timeout: 15_000,
              interval: 500,
            })
            .toContain(topic);

          const result = await callToolWithOAuthFlow(server, credentials, {
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
    },
  );
});
