import { DeleteSchemaHandler } from "@src/confluent/tools/handlers/schema/delete-schema-handler.js";
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
  TEST_AVRO_SCHEMA,
  withSharedSrClient,
} from "@tests/harness/schema-registry.js";
import { skipIfDisabled } from "@tests/harness/skip-gate.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new DeleteSchemaHandler();

describe(
  "delete-schema-handler",
  { tags: [Tag.SCHEMA, Tag.REQUIRES_SCHEMA_REGISTRY_CONFIG] },
  () => {
    // the handler's `hasSchemaRegistryOrOAuth` predicate accepts either a direct
    // `schema_registry` block or an OAuth connection; sibling describes exercise each path

    describe(`with a ${ConnectionType.DIRECT} connection`, () => {
      if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
        it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
        return;
      }
      if (skipIfDisabled(handler, integrationConnection())) {
        return;
      }

      // installs beforeAll/afterAll at this describe scope (shared SR client, subject cleanup)
      const { client, createdSubjects } = withSharedSrClient();

      describe.each(activeTransports)("via %s transport", (transport) => {
        let server: StartedServer;

        beforeAll(async () => {
          server = await startServer({ transport });
        });

        afterAll(async () => {
          await server?.stop();
        });

        it("should soft-delete a registered subject", async () => {
          // create a new schema+subject before we try to delete it
          const subject = uniqueName(`delete-${transport}`);
          createdSubjects.push(subject);
          await client().register(subject, { schema: TEST_AVRO_SCHEMA });
          // SR's listing is eventually consistent; poll until the new subject is visible before deleting
          await expect
            .poll(() => client().getAllSubjects(), {
              timeout: 15_000,
              interval: 500,
            })
            .toContain(subject);

          const result = await server.client.callTool({
            name: ToolName.DELETE_SCHEMA,
            arguments: { subject },
          });

          expect(textContent(result)).toContain(
            `Successfully deleted subject "${subject}"`,
          );
          // a soft delete removes the subject from the default `getAllSubjects()` listing
          await expect
            .poll(() => client().getAllSubjects(), {
              timeout: 15_000,
              interval: 500,
            })
            .not.toContain(subject);
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
        // `withSharedSrClient()` builds an api-key SR client from the direct fixture; gate the
        // OAuth describe on the same predicate the direct describe uses so an OAuth-only CI lane
        // without direct creds skips cleanly instead of crashing in beforeAll
        if (
          skipIfDisabled(
            handler,
            integrationConnection(),
            DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON,
          )
        ) {
          return;
        }

        // OAuth handlers don't carry a `schema_registry` block, so the SR endpoint is resolved at
        // call time from `environment_id`; under OAuth the handler errors when this arg is omitted
        const environmentId = getTestEnvironmentId();

        // seed via the test-side SR client (api-key auth); the server-side OAuth path is what
        // we're exercising via the DELETE_SCHEMA call below
        const { client, createdSubjects } = withSharedSrClient();

        describe.each(activeTransports)("via %s transport", (transport) => {
          let server: StartedServer;

          beforeAll(async () => {
            server = await startOAuthServer({ transport });
          }, 180_000);

          afterAll(async () => {
            await stopOAuthServer(server);
          });

          // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
          it("should soft-delete a registered subject", async () => {
            const subject = uniqueName(`delete-oauth-${transport}`);
            createdSubjects.push(subject);
            await client().register(subject, { schema: TEST_AVRO_SCHEMA });
            await expect
              .poll(() => client().getAllSubjects(), {
                timeout: 15_000,
                interval: 500,
              })
              .toContain(subject);

            const result = await callToolWithOAuthFlow(server, credentials, {
              name: ToolName.DELETE_SCHEMA,
              arguments: { subject, environment_id: environmentId },
            });

            expect(textContent(result)).toContain(
              `Successfully deleted subject "${subject}"`,
            );
            await expect
              .poll(() => client().getAllSubjects(), {
                timeout: 15_000,
                interval: 500,
              })
              .not.toContain(subject);
          });
        });
      },
    );
  },
);
