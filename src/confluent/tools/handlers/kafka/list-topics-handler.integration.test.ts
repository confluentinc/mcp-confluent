import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { getTestEnvironmentId } from "@tests/harness/confluent-cloud.js";
import {
  activeConnectionTypes,
  CONNECTION_TYPE_DIRECT_FILTERED_REASON,
  CONNECTION_TYPE_OAUTH_FILTERED_REASON,
  ConnectionType,
} from "@tests/harness/connection-types.js";
import { getTestClusterId } from "@tests/harness/kafka-admin.js";
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
import {
  activeOAuthTransports,
  activeTransports,
} from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListTopicsHandler();

describe(
  "list-topics-handler",
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

      describe.each(activeTransports)("via %s transport", (transport) => {
        let server: StartedServer;

        beforeAll(async () => {
          server = await startServer({ transport });
        });

        afterAll(async () => {
          await server?.stop();
        });

        it("should expose list-topics in tools/list", async () => {
          const { tools } = await server.client.listTools();

          const listTopics = tools.find((t) => t.name === ToolName.LIST_TOPICS);
          expect(listTopics).toBeDefined();
        });

        it("should return the topics from the configured Kafka cluster", async () => {
          const result = await server.client.callTool({
            name: ToolName.LIST_TOPICS,
            arguments: {},
          });

          // handler response is always prefixed with "Kafka topics:" whether the
          // cluster is empty or not, so this proves the tool ran end-to-end
          expect(textContent(result)).toMatch(/^Kafka topics:/);
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
        // `getTestClusterId()`/`getTestEnvironmentId()` read from the direct YAML; gate the OAuth
        // describe on the same predicate the direct describe uses so an OAuth-only CI lane without
        // direct creds skips cleanly instead of crashing on missing fixture
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
        // `cluster_id` + `environment_id` at call time; under OAuth the handler errors when
        // these args are omitted
        const clusterId = getTestClusterId();
        const environmentId = getTestEnvironmentId();

        describe.each(activeOAuthTransports)(
          "via %s transport",
          (transport) => {
            let server: StartedServer;

            beforeAll(async () => {
              server = await startOAuthServer({ transport });
            }, 180_000);

            afterAll(async () => {
              await stopOAuthServer(server);
            });

            it("should expose list-topics in tools/list", async () => {
              const { tools } = await server.client.listTools();
              const listTopics = tools.find(
                (t) => t.name === ToolName.LIST_TOPICS,
              );
              expect(listTopics).toBeDefined();
            });

            // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
            it("should return the topics from the configured Kafka cluster", async () => {
              const result = await callToolWithOAuthFlow(server, credentials, {
                name: ToolName.LIST_TOPICS,
                arguments: {
                  cluster_id: clusterId,
                  environment_id: environmentId,
                },
              });

              expect(textContent(result)).toMatch(/^Kafka topics:/);
            });
          },
        );
      },
    );
  },
);
