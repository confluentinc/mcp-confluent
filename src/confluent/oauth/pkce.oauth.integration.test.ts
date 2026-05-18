import { ToolName } from "@src/confluent/tools/tool-name.js";
import { TransportType } from "@src/mcp/transports/types.js";
import { driveOAuthFlow } from "@tests/harness/oauth-flow.js";
import {
  acquireOAuthPortLock,
  releaseOAuthPortLock,
} from "@tests/harness/oauth-port-lock.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Cross-cutting OAuth smoke: validates that PKCE drives end-to-end via playwright, the holder
// caches the resulting tokens, and a downstream tool call succeeds under bearer auth.
// stdio only (PKCE is transport-agnostic); serializes on OAUTH_CALLBACK_PORT via the port lock.

const runtime = integrationRuntime({ oauth: true });

describe("OAuth PKCE flow", { tags: [Tag.SMOKE] }, () => {
  if (Object.keys(runtime.config.connections).length === 0) {
    it.skip("requires an OAuth connection in test-fixtures/yaml_configs/integration-oauth.yaml", () => {});
    return;
  }
  // playwright drives the prod Auth0 sign-in form with these creds; populated by
  // `make setup-test-env` from vault path confluent-cloud-user.
  if (
    !process.env.CONFLUENT_CLOUD_USERNAME ||
    !process.env.CONFLUENT_CLOUD_PASSWORD
  ) {
    it.skip("requires CONFLUENT_CLOUD_USERNAME + CONFLUENT_CLOUD_PASSWORD for playwright-driven Auth0 sign-in", () => {});
    return;
  }
  const email = process.env.CONFLUENT_CLOUD_USERNAME;
  const password = process.env.CONFLUENT_CLOUD_PASSWORD;

  let server: StartedServer;

  beforeAll(async () => {
    // serialize against any other OAuth-flow file; stale locks auto-recover
    await acquireOAuthPortLock();
    server = await startServer({ transport: TransportType.STDIO, oauth: true });
  }, 180_000);

  afterAll(async () => {
    try {
      await server?.stop();
    } finally {
      releaseOAuthPortLock();
    }
  });

  it(
    "should complete PKCE via playwright and invoke an OAuth-eligible tool",
    // covers the Auth0 sign-in round-trip (form fill + consent + redirect) plus the cloud REST call
    { timeout: 120_000 },
    async () => {
      // drive PKCE and the triggering tool call concurrently: the call kicks PKCE on the server
      // side, the driver catches the auth URL from stderr and completes the sign-in
      const flowPromise = driveOAuthFlow(server, { email, password });
      const callPromise = server.client.callTool({
        name: ToolName.LIST_ORGANIZATIONS,
        arguments: {},
      });

      const [, result] = await Promise.all([flowPromise, callPromise]);

      expect(textContent(result)).toMatch(/^Retrieved \d+ organizations?:/);
    },
  );
});
