import { ListSchemasHandler } from "@src/confluent/tools/handlers/schema/list-schemas-handler.js";
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
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  TEST_AVRO_SCHEMA,
  withSharedSrClient,
} from "@tests/harness/schema-registry.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListSchemasHandler();

describe("list-schemas-handler", { tags: [Tag.SCHEMA] }, () => {
  // the handler's `hasSchemaRegistryOrOAuth` predicate accepts either a direct
  // `schema_registry` block or an OAuth connection; sibling describes exercise each path

  describe(`with a ${ConnectionType.DIRECT} connection`, () => {
    if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
      it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
      return;
    }
    const directRuntime = integrationRuntime({ oauth: false });
    if (handler.enabledConnectionIds(directRuntime).length === 0) {
      it.skip("requires schema_registry.endpoint + schema_registry.auth in test-fixtures/yaml_configs/integration.yaml", () => {});
      return;
    }

    // installs beforeAll/afterAll at this describe scope (shared SR client, subject cleanup)
    const { client, createdSubjects } = withSharedSrClient();
    const subject = uniqueName("list");

    // seed one subject so the assertion still fires against a brand-new empty registry
    beforeAll(async () => {
      await client().register(subject, { schema: TEST_AVRO_SCHEMA });
      createdSubjects.push(subject);
    });

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose list-schemas in tools/list", async () => {
        const { tools } = await server.client.listTools();

        const listSchemas = tools.find((t) => t.name === ToolName.LIST_SCHEMAS);
        expect(listSchemas).toBeDefined();
      });

      it("should return a subject map that includes the seeded subject", async () => {
        const result = await server.client.callTool({
          name: ToolName.LIST_SCHEMAS,
          arguments: { subjectPrefix: subject },
        });

        expect(result.isError, textContent(result)).not.toBe(true);
        // handler stringifies a `Record<subject, metadata>` map; the prefix filter narrows the
        // response to a single-key object
        const parsed = JSON.parse(textContent(result));
        expect(parsed).toHaveProperty(subject);
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
      // `withSharedSrClient()` builds an api-key SR client from the direct fixture; gate the
      // OAuth describe on the same predicate the direct describe uses so an OAuth-only CI lane
      // without direct creds skips cleanly instead of crashing in beforeAll
      const directRuntime = integrationRuntime({ oauth: false });
      if (handler.enabledConnectionIds(directRuntime).length === 0) {
        it.skip(DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON, () => {});
        return;
      }

      // OAuth handlers don't carry a `schema_registry` block, so the SR endpoint is resolved at
      // call time from `environment_id`; under OAuth the handler errors when this arg is omitted
      const environmentId = getTestEnvironmentId();

      // seed via the test-side SR client (api-key auth); the server-side OAuth path is what
      // we're exercising via the LIST_SCHEMAS call below
      const { client, createdSubjects } = withSharedSrClient();
      const subject = uniqueName("list-oauth");

      beforeAll(async () => {
        await client().register(subject, { schema: TEST_AVRO_SCHEMA });
        createdSubjects.push(subject);
      });

      describe.each(activeTransports)("via %s transport", (transport) => {
        let server: StartedServer;

        beforeAll(async () => {
          server = await startOAuthServer({ transport });
        }, 180_000);

        afterAll(async () => {
          await stopOAuthServer(server);
        });

        it("should expose list-schemas in tools/list", async () => {
          const { tools } = await server.client.listTools();
          const listSchemas = tools.find(
            (t) => t.name === ToolName.LIST_SCHEMAS,
          );
          expect(listSchemas).toBeDefined();
        });

        // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
        it("should return a subject map that includes the seeded subject", async () => {
          const result = await callToolWithOAuthFlow(server, credentials, {
            name: ToolName.LIST_SCHEMAS,
            arguments: {
              subjectPrefix: subject,
              environment_id: environmentId,
            },
          });

          expect(result.isError, textContent(result)).not.toBe(true);
          const parsed = JSON.parse(textContent(result));
          expect(parsed).toHaveProperty(subject);
        });
      });
    },
  );
});
