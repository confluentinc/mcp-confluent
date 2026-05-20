import { ListBillingCostsHandler } from "@src/confluent/tools/handlers/billing/list-billing-costs-handler.js";
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

const handler = new ListBillingCostsHandler();

// CCloud's billing API requires start_date strictly before end_date, so the smallest valid range is
// from "two days ago" to "yesterday"
function utcDate(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10); // "YYYY-MM-DD"
}
const startDate = utcDate(2);
const endDate = utcDate(1);

describe("list-billing-costs-handler", { tags: [Tag.BILLING] }, () => {
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

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose list-billing-costs in tools/list", async () => {
        const { tools } = await server.client.listTools();
        expect(
          tools.find((t) => t.name === ToolName.LIST_BILLING_COSTS),
        ).toBeDefined();
      });

      it("should return billing costs for a 1-day window", async () => {
        const result = await server.client.callTool({
          name: ToolName.LIST_BILLING_COSTS,
          arguments: { startDate, endDate },
        });

        expect(result.isError).not.toBe(true);
        // handler emits this prefix whether or not the window has line items, so an empty response
        // still proves the tool ran end-to-end
        expect(textContent(result)).toMatch(
          /^Successfully retrieved billing costs:/,
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

      describe.each(activeTransports)("via %s transport", (transport) => {
        let server: StartedServer;

        beforeAll(async () => {
          server = await startOAuthServer({ transport });
        }, 180_000);

        afterAll(async () => {
          await stopOAuthServer(server);
        });

        it("should expose list-billing-costs in tools/list", async () => {
          const { tools } = await server.client.listTools();
          expect(
            tools.find((t) => t.name === ToolName.LIST_BILLING_COSTS),
          ).toBeDefined();
        });

        // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
        it("should return billing costs for a 1-day window", async () => {
          const result = await callToolWithOAuthFlow(server, credentials, {
            name: ToolName.LIST_BILLING_COSTS,
            arguments: { startDate, endDate },
          });

          expect(result.isError).not.toBe(true);
          expect(textContent(result)).toMatch(
            /^Successfully retrieved billing costs:/,
          );
        });
      });
    },
  );
});
