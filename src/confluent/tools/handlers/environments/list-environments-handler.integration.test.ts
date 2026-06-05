import { ListEnvironmentsHandler } from "@src/confluent/tools/handlers/environments/list-environments-handler.js";
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
import { integrationConnection } from "@tests/harness/runtime.js";
import { skipIfNotEnabled } from "@tests/harness/skip-gate.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListEnvironmentsHandler();

describe(
  "list-environments-handler",
  { tags: [Tag.ENVIRONMENTS, Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG] },
  () => {
    // the handler's `hasConfluentCloudOrOAuth` predicate accepts either an API-key-authed
    // `confluent_cloud` block or an OAuth connection; sibling describes exercise each path

    describe(`with a ${ConnectionType.DIRECT} connection`, () => {
      if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
        it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
        return;
      }
      if (skipIfNotEnabled(handler, integrationConnection())) {
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

        it("should expose list-environments in tools/list", async () => {
          const { tools } = await server.client.listTools();
          expect(
            tools.find((t) => t.name === ToolName.LIST_ENVIRONMENTS),
          ).toBeDefined();
        });

        it("should return at least one environment from CCloud", async () => {
          const result = await server.client.callTool({
            name: ToolName.LIST_ENVIRONMENTS,
            arguments: {},
          });
          // handler's success line starts with "Successfully retrieved N environments:"
          expect(textContent(result)).toMatch(
            /^Successfully retrieved \d+ environments:/,
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

        describe.each(activeTransports)("via %s transport", (transport) => {
          let server: StartedServer;

          beforeAll(async () => {
            server = await startOAuthServer({ transport });
          }, 180_000);

          afterAll(async () => {
            await stopOAuthServer(server);
          });

          it("should expose list-environments in tools/list", async () => {
            const { tools } = await server.client.listTools();
            expect(
              tools.find((t) => t.name === ToolName.LIST_ENVIRONMENTS),
            ).toBeDefined();
          });

          // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
          it("should return at least one environment from CCloud", async () => {
            const result = await callToolWithOAuthFlow(server, credentials, {
              name: ToolName.LIST_ENVIRONMENTS,
              arguments: {},
            });
            // handler's success line starts with "Successfully retrieved N environments:"
            expect(textContent(result)).toMatch(
              /^Successfully retrieved \d+ environments:/,
            );
          });
        });
      },
    );
  },
);
