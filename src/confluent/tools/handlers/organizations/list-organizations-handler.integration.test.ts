import { ListOrganizationsHandler } from "@src/confluent/tools/handlers/organizations/list-organizations-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  activeConnectionTypes,
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

// Dual-mode test: the handler's `hasConfluentCloudOrOAuth` predicate accepts
// either an api-key-authed `confluent_cloud` block (direct) or an OAuth
// connection. We iterate `activeConnectionTypes` x `activeTransports` so a CI
// lane can clip either axis via `INTEGRATION_TEST_CONNECTION_TYPE` /
// `INTEGRATION_TEST_TRANSPORT`.

const handler = new ListOrganizationsHandler();

for (const connection of activeConnectionTypes) {
  const isOAuth = connection === ConnectionType.OAUTH;
  const runtime = integrationRuntime({ oauth: isOAuth });

  const tags = isOAuth ? [Tag.ORGANIZATIONS, Tag.OAUTH] : [Tag.ORGANIZATIONS];

  describe(`list-organizations-handler (${connection})`, { tags }, () => {
    if (handler.enabledConnectionIds(runtime).length === 0) {
      const reason = isOAuth
        ? OAUTH_FIXTURE_NOT_LOADED_REASON
        : "requires confluent_cloud.auth in test-fixtures/yaml_configs/integration.yaml";
      it.skip(reason, () => {});
      return;
    }
    const credentials = isOAuth ? getOAuthCredentialsFromEnv() : undefined;
    if (isOAuth && !credentials) {
      it.skip(OAUTH_USER_CREDS_MISSING_REASON, () => {});
      return;
    }

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = isOAuth
          ? await startOAuthServer({ transport })
          : await startServer({ transport });
      }, 180_000);

      afterAll(async () => {
        if (isOAuth) await stopOAuthServer(server);
        else await server?.stop();
      });

      it("should expose list-organizations in tools/list", async () => {
        const { tools } = await server.client.listTools();

        expect(
          tools.find((t) => t.name === ToolName.LIST_ORGANIZATIONS),
        ).toBeDefined();
      });

      // First auth-required call: kicks off the CCloud OAuth flow (cached for
      // any subsequent auth-required `it`s a future contributor adds).
      it("should return at least one organization from CCloud", async () => {
        const callArgs = {
          name: ToolName.LIST_ORGANIZATIONS,
          arguments: {},
        };
        const result =
          isOAuth && credentials
            ? await callToolWithOAuthFlow(server, credentials, callArgs)
            : await server.client.callTool(callArgs);

        expect(textContent(result)).toMatch(/^Retrieved \d+ organizations?:/);
      });
    });
  });
}
