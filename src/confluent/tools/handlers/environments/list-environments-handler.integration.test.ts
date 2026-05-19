import { ListEnvironmentsHandler } from "@src/confluent/tools/handlers/environments/list-environments-handler.js";
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

// the handler's `hasConfluentCloudOrOAuth` predicate accepts either an API-key-authed
// `confluent_cloud` block or an OAuth connection

const handler = new ListEnvironmentsHandler();

for (const connection of activeConnectionTypes) {
  const isOAuth = connection === ConnectionType.OAUTH;
  const runtime = integrationRuntime({ oauth: isOAuth });

  const tags = isOAuth ? [Tag.ENVIRONMENTS, Tag.OAUTH] : [Tag.ENVIRONMENTS];

  describe(`list-environments-handler (${connection})`, { tags }, () => {
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

      it("should expose list-environments in tools/list", async () => {
        const { tools } = await server.client.listTools();
        expect(
          tools.find((t) => t.name === ToolName.LIST_ENVIRONMENTS),
        ).toBeDefined();
      });

      // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
      it("should return at least one environment from CCloud", async () => {
        const callArgs = {
          name: ToolName.LIST_ENVIRONMENTS,
          arguments: {},
        };
        const result =
          isOAuth && credentials
            ? await callToolWithOAuthFlow(server, credentials, callArgs)
            : await server.client.callTool(callArgs);

        // handler's success line starts with "Successfully retrieved N environments:"
        expect(textContent(result)).toMatch(
          /^Successfully retrieved \d+ environments:/,
        );
      });
    });
  });
}
