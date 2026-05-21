import { CreateTopicsHandler } from "@src/confluent/tools/handlers/kafka/create-topics-handler.js";
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
  DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON,
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

const handler = new CreateTopicsHandler();

describe("create-topics-handler", { tags: [Tag.KAFKA] }, () => {
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

      it("should create the requested Kafka topic", async () => {
        const topic = uniqueName(`create-${transport}`);
        // track for cleanup before the call so a thrown callTool still enqueues
        // the topic for afterAll deletion if creation partially succeeded
        createdTopics.push(topic);

        const result = await server.client.callTool({
          name: ToolName.CREATE_TOPICS,
          arguments: { topics: [{ topic, numPartitions: 1 }] },
        });

        expect(result.isError, textContent(result)).not.toBe(true);

        await expect
          .poll(() => admin().listTopics(), {
            timeout: 15_000,
            interval: 500,
          })
          .toContain(topic);
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
      // `withSharedAdminClient()` builds an api-key kafka client from the direct fixture; gate
      // the OAuth describe on the same predicate the direct describe uses so an OAuth-only CI
      // lane without direct creds skips cleanly instead of crashing in beforeAll
      const directRuntime = integrationRuntime({ oauth: false });
      if (handler.enabledConnectionIds(directRuntime).length === 0) {
        it.skip(DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON, () => {});
        return;
      }

      // verification uses the api-key-authed admin client to confirm the OAuth-mode server's call
      // actually mutated the cluster
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
        it("should create the requested Kafka topic", async () => {
          const topic = uniqueName(`create-oauth-${transport}`);
          createdTopics.push(topic);

          const result = await callToolWithOAuthFlow(server, credentials, {
            name: ToolName.CREATE_TOPICS,
            arguments: { topics: [{ topic, numPartitions: 1 }] },
          });

          expect(result.isError, textContent(result)).not.toBe(true);

          await expect
            .poll(() => admin().listTopics(), {
              timeout: 15_000,
              interval: 500,
            })
            .toContain(topic);
        });
      });
    },
  );
});
