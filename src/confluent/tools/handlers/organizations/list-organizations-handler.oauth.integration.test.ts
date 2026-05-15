import { ListOrganizationsHandler } from "@src/confluent/tools/handlers/organizations/list-organizations-handler.js";
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

// OAuth-only test for this handler. stdio only: PKCE is transport-agnostic.

const handler = new ListOrganizationsHandler();
const runtime = integrationRuntime({ oauth: true });

describe("list-organizations-handler", { tags: [Tag.ORGANIZATIONS] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires an OAuth connection in test-fixtures/yaml_configs/integration-oauth.yaml", () => {});
    return;
  }
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
    // serialize against any other OAuth-flow file on the hardcoded OAUTH_CALLBACK_PORT
    await acquireOAuthPortLock();
    server = await startServer({ transport: TransportType.STDIO, oauth: true });
    // run PKCE once up front so each `it` block doesn't have to coordinate the flow + call.
    // subsequent tool calls reuse the holder's cached bearer tokens.
    const flow = driveOAuthFlow(server, { email, password });
    const warmup = server.client.callTool({
      name: ToolName.LIST_ORGANIZATIONS,
      arguments: {},
    });
    await Promise.all([flow, warmup]);
  }, 180_000);

  afterAll(async () => {
    try {
      await server?.stop();
    } finally {
      releaseOAuthPortLock();
    }
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
