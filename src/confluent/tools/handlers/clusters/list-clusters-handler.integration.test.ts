import { ListClustersHandler } from "@src/confluent/tools/handlers/clusters/list-clusters-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { getTestEnvironmentId } from "@tests/harness/confluent-cloud.js";
import {
  activeConnectionTypes,
  CONNECTION_TYPE_DIRECT_FILTERED_REASON,
  CONNECTION_TYPE_OAUTH_FILTERED_REASON,
  ConnectionType,
} from "@tests/harness/connection-types.js";
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
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListClustersHandler();

describe(
  "list-clusters-handler",
  { tags: [Tag.CLUSTERS, Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG] },
  () => {
    // the handler's `hasConfluentCloudOrOAuth` predicate accepts either an API-key-authed
    // `confluent_cloud` block or an OAuth connection; sibling describes exercise each path

    describe(`with a ${ConnectionType.DIRECT} connection`, () => {
      if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
        it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
        return;
      }
      const verdict = handler.predicate(integrationConnection());
      if (!verdict.enabled) {
        it.skip(verdict.reason, () => {});
        return;
      }
      const environmentId = getTestEnvironmentId();

      describe.each(activeTransports)("via %s transport", (transport) => {
        let server: StartedServer;

        beforeAll(async () => {
          server = await startServer({ transport });
        });

        afterAll(async () => {
          await server?.stop();
        });

        it("should expose list-clusters in tools/list", async () => {
          const { tools } = await server.client.listTools();
          expect(
            tools.find((t) => t.name === ToolName.LIST_CLUSTERS),
          ).toBeDefined();
        });

        it("should return clusters for the resolved environment id", async () => {
          const result = await server.client.callTool({
            name: ToolName.LIST_CLUSTERS,
            arguments: { environmentId },
          });

          expect(textContent(result)).toMatch(
            /^Successfully retrieved [1-9]\d* clusters:/,
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
        if (
          !handler.predicate(integrationConnection({ oauth: true })).enabled
        ) {
          it.skip(OAUTH_FIXTURE_NOT_LOADED_REASON, () => {});
          return;
        }
        const credentials = getOAuthCredentialsFromEnv();
        if (!credentials) {
          it.skip(OAUTH_USER_CREDS_MISSING_REASON, () => {});
          return;
        }
        // `getTestEnvironmentId()` reads `kafka.env_id` out of the direct YAML; gate the OAuth
        // describe on the same predicate the direct describe uses so an OAuth-only CI lane without
        // direct creds skips cleanly instead of crashing on missing fixture
        if (!handler.predicate(integrationConnection()).enabled) {
          it.skip(DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON, () => {});
          return;
        }
        // env id is read from the direct YAML; the OAuth-mode handler itself talks to CCloud via OAuth
        const environmentId = getTestEnvironmentId();

        describe.each(activeTransports)("via %s transport", (transport) => {
          let server: StartedServer;

          beforeAll(async () => {
            server = await startOAuthServer({ transport });
          }, 180_000);

          afterAll(async () => {
            await stopOAuthServer(server);
          });

          it("should expose list-clusters in tools/list", async () => {
            const { tools } = await server.client.listTools();
            expect(
              tools.find((t) => t.name === ToolName.LIST_CLUSTERS),
            ).toBeDefined();
          });

          // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
          it("should return clusters for the resolved environment id", async () => {
            const result = await callToolWithOAuthFlow(server, credentials, {
              name: ToolName.LIST_CLUSTERS,
              arguments: { environmentId },
            });

            expect(textContent(result)).toMatch(
              /^Successfully retrieved [1-9]\d* clusters:/,
            );
          });
        });
      },
    );
  },
);
