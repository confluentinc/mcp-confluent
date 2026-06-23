import { ReadEnvironmentHandler } from "@src/confluent/tools/handlers/environments/read-environment-handler.js";
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

const handler = new ReadEnvironmentHandler();

describe(
  "read-environment-handler",
  { tags: [Tag.ENVIRONMENTS, Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG] },
  () => {
    // the handler's `hasConfluentCloudOrOAuth` predicate accepts either an API-key-authed
    // `confluent_cloud` block or an OAuth connection; sibling describes exercise each path

    describe(`with a ${ConnectionType.DIRECT} connection`, () => {
      if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
        it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
        return;
      }
      if (skipIfDisabled(handler, integrationConnection())) {
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

        it("should expose read-environment in tools/list", async () => {
          const { tools } = await server.client.listTools();
          expect(
            tools.find((t) => t.name === ToolName.READ_ENVIRONMENT),
          ).toBeDefined();
        });

        it("should return details for the resolved environment id", async () => {
          const result = await server.client.callTool({
            name: ToolName.READ_ENVIRONMENT,
            arguments: { environmentId },
          });

          expect(textContent(result)).toContain(`ID: ${environmentId}`);
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
        // `getTestEnvironmentId()` reads `kafka.env_id` out of the direct YAML; gate the OAuth
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
        // env id is read from the direct YAML; the OAuth-mode handler itself talks to CCloud via OAuth
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

            it("should expose read-environment in tools/list", async () => {
              const { tools } = await server.client.listTools();
              expect(
                tools.find((t) => t.name === ToolName.READ_ENVIRONMENT),
              ).toBeDefined();
            });

            // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
            it("should return details for the resolved environment id", async () => {
              const result = await callToolWithOAuthFlow(server, credentials, {
                name: ToolName.READ_ENVIRONMENT,
                arguments: { environmentId },
              });

              expect(textContent(result)).toContain(`ID: ${environmentId}`);
            });
          },
        );
      },
    );
  },
);
