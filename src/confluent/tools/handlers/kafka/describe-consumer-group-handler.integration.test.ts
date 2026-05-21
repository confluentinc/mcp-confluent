import { DescribeConsumerGroupHandler } from "@src/confluent/tools/handlers/kafka/describe-consumer-group-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { getTestEnvironmentId } from "@tests/harness/confluent-cloud.js";
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
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new DescribeConsumerGroupHandler();

describe("describe-consumer-group-handler", { tags: [Tag.KAFKA] }, () => {
  // the handler's `kafkaBootstrapOrOAuth` predicate accepts either a direct
  // `kafka.bootstrap_servers` block or an OAuth connection; sibling describes exercise each path.
  //
  // The OAuth describe only runs the happy-path describe call — the not-found error-surface
  // test lives in the direct describe since it exercises handler logic that doesn't change
  // between auth modes.

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

    // Test-side admin client used once (outer-scope beforeAll) to discover a
    // real group ID to describe. Without an existing group the test has nothing
    // meaningful to assert against; skip vs. assert is a judgment call — picked
    // skip here because "no consumer groups on the test cluster" is a legitimate
    // env state (e.g. nothing's been provisioned yet), not the kind of broken-env
    // failure that should page someone.
    const { admin } = withSharedAdminClient();
    let discoveredGroupId: string | undefined;

    beforeAll(async () => {
      const { groups } = await admin().listGroups();
      discoveredGroupId = groups[0]?.groupId;
    });

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose describe-consumer-group in tools/list", async () => {
        const { tools } = await server.client.listTools();

        const describeConsumerGroup = tools.find(
          (t) => t.name === ToolName.DESCRIBE_CONSUMER_GROUP,
        );
        expect(describeConsumerGroup).toBeDefined();
      });

      it("should describe an existing consumer group end-to-end", async (ctx) => {
        if (discoveredGroupId === undefined) {
          ctx.skip(
            "no consumer groups present on the test cluster to describe",
          );
          return;
        }

        const result = await server.client.callTool({
          name: ToolName.DESCRIBE_CONSUMER_GROUP,
          arguments: { groupId: discoveredGroupId },
        });

        // The handler emits a `Consumer group "<id>" is <state> ...` prefix on
        // every success path (Stable / Empty / etc.), and the requested id
        // appears verbatim in the text — so this proves the tool ran
        // end-to-end against a real broker AND returned the right group.
        // Use a literal `startsWith` (via the text-and-message expect form)
        // rather than `new RegExp(...)` — consumer group IDs can legally
        // contain regex metacharacters (`.`, `[`, etc.), which would either
        // throw on RegExp construction or false-match in the assertion.
        const text = textContent(result);
        const expectedPrefix = `Consumer group "${discoveredGroupId}" is `;
        expect(text.startsWith(expectedPrefix), text).toBe(true);
      });

      it("should return the caller-friendly not-found error for an unknown group ID", async () => {
        const result = await server.client.callTool({
          name: ToolName.DESCRIBE_CONSUMER_GROUP,
          arguments: { groupId: "int-no-such-group-2147483647" },
        });

        expect(result.isError).toBe(true);
        expect(textContent(result)).toBe(
          'Consumer group "int-no-such-group-2147483647" not found on this cluster.',
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
      // `withSharedAdminClient()` builds an api-key kafka client from the direct fixture; gate
      // the OAuth describe on the same predicate the direct describe uses so an OAuth-only CI
      // lane without direct creds skips cleanly instead of crashing in beforeAll
      const directRuntime = integrationRuntime({ oauth: false });
      if (handler.enabledConnectionIds(directRuntime).length === 0) {
        it.skip(DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON, () => {});
        return;
      }

      // OAuth handlers don't carry a `kafka` block, so the broker is resolved at call time from
      // `environment_id`; under OAuth the handler errors when this arg is omitted
      const environmentId = getTestEnvironmentId();

      // discover via the api-key-authed admin client; DESCRIBE_CONSUMER_GROUP goes via OAuth
      const { admin } = withSharedAdminClient();
      let discoveredGroupId: string | undefined;

      beforeAll(async () => {
        const { groups } = await admin().listGroups();
        discoveredGroupId = groups[0]?.groupId;
      });

      describe.each(activeTransports)("via %s transport", (transport) => {
        let server: StartedServer;

        beforeAll(async () => {
          server = await startOAuthServer({ transport });
        }, 180_000);

        afterAll(async () => {
          await stopOAuthServer(server);
        });

        // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
        it("should describe an existing consumer group end-to-end", async (ctx) => {
          if (discoveredGroupId === undefined) {
            ctx.skip(
              "no consumer groups present on the test cluster to describe",
            );
            return;
          }

          const result = await callToolWithOAuthFlow(server, credentials, {
            name: ToolName.DESCRIBE_CONSUMER_GROUP,
            arguments: {
              groupId: discoveredGroupId,
              environment_id: environmentId,
            },
          });

          const text = textContent(result);
          const expectedPrefix = `Consumer group "${discoveredGroupId}" is `;
          expect(text.startsWith(expectedPrefix), text).toBe(true);
        });
      });
    },
  );
});
