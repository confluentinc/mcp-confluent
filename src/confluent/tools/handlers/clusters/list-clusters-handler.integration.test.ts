import { ListClustersHandler } from "@src/confluent/tools/handlers/clusters/list-clusters-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { getFirstTestEnvironmentId } from "@tests/harness/confluent-cloud.js";
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

const handler = new ListClustersHandler();

describe("list-clusters-handler", { tags: [Tag.CLUSTERS] }, () => {
  // the handler's `hasConfluentCloudOrOAuth` predicate accepts either an API-key-authed
  // `confluent_cloud` block or an OAuth connection; sibling describes exercise each path

  describe(`with a ${ConnectionType.DIRECT} connection`, () => {
    if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
      it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
      return;
    }
    const directRuntime = integrationRuntime({ oauth: false });
    if (handler.enabledConnectionIds(directRuntime).length === 0) {
      it.skip("requires confluent_cloud.auth in test-fixtures/yaml_configs/integration.yaml", () => {});
      return;
    }

    // resolve once per file - same env id across all transport iterations
    let environmentId: string;
    beforeAll(async () => {
      environmentId = await getFirstTestEnvironmentId();
    });

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

      // env id discovery uses direct CCloud creds — OAuth-mode CI lanes that
      // run this group still have `.env.integration` loaded, so the helper is
      // a cheap shared lookup. The handler itself talks to CCloud via OAuth.
      let environmentId: string;
      beforeAll(async () => {
        environmentId = await getFirstTestEnvironmentId();
      });

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
});
