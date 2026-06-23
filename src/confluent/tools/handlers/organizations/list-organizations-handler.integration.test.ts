import { ListOrganizationsHandler } from "@src/confluent/tools/handlers/organizations/list-organizations-handler.js";
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

const handler = new ListOrganizationsHandler();

describe(
  "list-organizations-handler",
  { tags: [Tag.ORGANIZATIONS, Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG] },
  () => {
    // the handler's `hasConfluentCloudOrOAuth` predicate accepts either an API-key-authed
    // `confluent_cloud` block or an OAuth connection; sibling describe blocks exercise each path

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

        it("should expose list-organizations in tools/list", async () => {
          const { tools } = await server.client.listTools();
          expect(
            tools.find((t) => t.name === ToolName.LIST_ORGANIZATIONS),
          ).toBeDefined();
        });

        it("should return at least one organization from CCloud", async () => {
          const result = await server.client.callTool({
            name: ToolName.LIST_ORGANIZATIONS,
            arguments: {},
          });
          expect(textContent(result)).toMatch(/^Retrieved \d+ organizations?:/);
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

            it("should expose list-organizations in tools/list", async () => {
              const { tools } = await server.client.listTools();
              expect(
                tools.find((t) => t.name === ToolName.LIST_ORGANIZATIONS),
              ).toBeDefined();
            });

            // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
            it("should return at least one organization from CCloud", async () => {
              const result = await callToolWithOAuthFlow(server, credentials, {
                name: ToolName.LIST_ORGANIZATIONS,
                arguments: {},
              });
              expect(textContent(result)).toMatch(
                /^Retrieved \d+ organizations?:/,
              );
            });
          },
        );
      },
    );
  },
);
