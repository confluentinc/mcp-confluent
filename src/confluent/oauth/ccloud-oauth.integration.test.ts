import { ToolName } from "@src/confluent/tools/tool-name.js";
import { TransportType } from "@src/mcp/transports/types.js";
import {
  callToolWithOAuthFlow,
  getOAuthCredentialsFromEnv,
  OAUTH_FIXTURE_NOT_LOADED_REASON,
  OAUTH_USER_CREDS_MISSING_REASON,
  startOAuthServer,
  stopOAuthServer,
} from "@tests/harness/oauth-flow.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import { type StartedServer } from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Cross-cutting OAuth smoke: validates that the CCloud OAuth flow drives end-to-end via
// playwright, the holder caches the resulting tokens, and a downstream tool call succeeds under
// bearer auth. stdio only (the flow is transport-agnostic); serializes on OAUTH_CALLBACK_PORT
// via the port lock.

const runtime = integrationRuntime({ oauth: true });

describe("CCloud OAuth flow", { tags: [Tag.SMOKE, Tag.OAUTH] }, () => {
  if (Object.keys(runtime.config.connections).length === 0) {
    it.skip(OAUTH_FIXTURE_NOT_LOADED_REASON, () => {});
    return;
  }
  // playwright drives the prod Auth0 sign-in form with these creds; populated by
  // `make setup-test-env` from vault path confluent-cloud-user.
  const credentials = getOAuthCredentialsFromEnv();
  if (!credentials) {
    it.skip(OAUTH_USER_CREDS_MISSING_REASON, () => {});
    return;
  }

  let server: StartedServer;

  beforeAll(async () => {
    server = await startOAuthServer({ transport: TransportType.STDIO });
  }, 180_000);

  afterAll(async () => {
    await stopOAuthServer(server);
  });

  it(
    "should complete the CCloud OAuth flow via playwright and invoke an OAuth-eligible tool",
    // covers the Auth0 sign-in round-trip (form fill + consent + redirect) plus the cloud REST call
    { timeout: 120_000 },
    async () => {
      const result = await callToolWithOAuthFlow(server, credentials, {
        name: ToolName.LIST_ORGANIZATIONS,
        arguments: {},
      });

      expect(textContent(result)).toMatch(/^Retrieved \d+ organizations?:/);
    },
  );
});
