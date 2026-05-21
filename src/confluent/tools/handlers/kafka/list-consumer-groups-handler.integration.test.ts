import { ListConsumerGroupsHandler } from "@src/confluent/tools/handlers/kafka/list-consumer-groups-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  activeConnectionTypes,
  CONNECTION_TYPE_DIRECT_FILTERED_REASON,
  CONNECTION_TYPE_OAUTH_FILTERED_REASON,
  ConnectionType,
} from "@tests/harness/connection-types.js";
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
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListConsumerGroupsHandler();

describe("list-consumer-groups-handler", { tags: [Tag.KAFKA] }, () => {
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

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose list-consumer-groups in tools/list", async () => {
        const { tools } = await server.client.listTools();

        const listConsumerGroups = tools.find(
          (t) => t.name === ToolName.LIST_CONSUMER_GROUPS,
        );
        expect(listConsumerGroups).toBeDefined();
      });

      it("should return the consumer groups from the configured Kafka cluster", async () => {
        const result = await server.client.callTool({
          name: ToolName.LIST_CONSUMER_GROUPS,
          arguments: {},
        });

        // handler always emits a "Found N consumer group(s)" prefix on the
        // text summary whether the cluster has zero groups or many, so this
        // proves the tool ran end-to-end against a real broker.
        expect(textContent(result)).toMatch(/^Found \d+ consumer group/);
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

      describe.each(activeTransports)("via %s transport", (transport) => {
        let server: StartedServer;

        beforeAll(async () => {
          server = await startOAuthServer({ transport });
        }, 180_000);

        afterAll(async () => {
          await stopOAuthServer(server);
        });

        it("should expose list-consumer-groups in tools/list", async () => {
          const { tools } = await server.client.listTools();
          const listConsumerGroups = tools.find(
            (t) => t.name === ToolName.LIST_CONSUMER_GROUPS,
          );
          expect(listConsumerGroups).toBeDefined();
        });

        // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
        it("should return the consumer groups from the configured Kafka cluster", async () => {
          const result = await callToolWithOAuthFlow(server, credentials, {
            name: ToolName.LIST_CONSUMER_GROUPS,
            arguments: {},
          });

          expect(textContent(result)).toMatch(/^Found \d+ consumer group/);
        });
      });
    },
  );
});
