import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { initEnv } from "@src/env.js";
import { createMcpServer, type ToolCallProps } from "@src/mcp/server.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { ccloudOAuthRuntime, runtimeWith } from "@tests/factories/runtime.js";
import { createTestServer, TestServerContext } from "@tests/server.js";
import { createMockInstance, StubHandler } from "@tests/stubs/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ALL_TOOL_NAMES = Object.values(ToolName);

// covers protocol-level behavior that needs a connected client; pure registration shape lives
// in the unit suite next to src/mcp/server.ts
describe("MCP server", () => {
  let ctx: TestServerContext;

  beforeEach(async () => {
    // registers all tools by default
    ctx = await createTestServer(runtimeWith());
  });

  afterEach(() => ctx.shutdown());

  it("should report server info after handshake", () => {
    const info = ctx.client.getServerVersion();

    expect(info?.name).toBeDefined();
    expect(info?.version).toBeDefined();
  });

  it("should register all tools via MCP protocol", async () => {
    const { tools } = await ctx.client.listTools();

    expect(tools).toHaveLength(ALL_TOOL_NAMES.length);
  });

  it("should advertise each tool's category via _meta on tools/list", async () => {
    const { tools } = await ctx.client.listTools();

    // Spot-check two tools with different categories. Asserting every tool
    // would just retread the registry-driven category wiring; here we only
    // need to prove the meta field rides out on the wire.
    const listTopics = tools.find((t) => t.name === ToolName.LIST_TOPICS);
    expect(listTopics?._meta).toEqual({ category: "kafka" });

    const searchDocs = tools.find(
      (t) => t.name === ToolName.SEARCH_PRODUCT_DOCS,
    );
    expect(searchDocs?._meta).toEqual({ category: "docs" });
  });
});

/**
 * Spins up an {@linkcode createMcpServer} with a custom handler map (rather
 * than the full registry) over an InMemoryTransport pair.
 */
async function startServerWith(
  toolHandlers: Map<ToolName, ToolHandler>,
  runtime: ServerRuntime,
  track?: (props: ToolCallProps) => void,
): Promise<{
  client: Client;
  shutdown: () => Promise<void>;
}> {
  await initEnv();
  const server = createMcpServer({
    serverVersion: "0.0.0-test",
    toolHandlers,
    runtime,
    track,
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0-test" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    shutdown: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe("MCP server tool-call gate", () => {
  // StubHandler({ enabled: false }) yields a predicate that's not
  // `alwaysEnabled` (it returns a disabled-result), which is the condition
  // the gate uses to decide to launch the OAuth login. The "tool disabled"
  // semantics are incidental — the gate doesn't read the predicate's
  // result, only its identity.
  it("should call ensureLoggedIn() before handle() when an OAuth holder is present and predicate is not alwaysEnabled", async () => {
    const holder = createMockInstance(OAuthHolder);
    holder.ensureLoggedIn.mockResolvedValue(undefined);
    const handler = new StubHandler({ enabled: false });

    const { client, shutdown } = await startServerWith(
      new Map([[ToolName.LIST_TOPICS, handler]]),
      ccloudOAuthRuntime(holder),
    );
    try {
      await client.callTool({ name: ToolName.LIST_TOPICS, arguments: {} });
      expect(holder.ensureLoggedIn).toHaveBeenCalledOnce();
    } finally {
      await shutdown();
    }
  });

  it("should NOT call ensureLoggedIn() when handler.predicate is alwaysEnabled (e.g., docs lookups)", async () => {
    // Doc-lookup tools have predicate = alwaysEnabled and never touch the
    // OAuth client manager. Gating them would surprise the user with a
    // browser tab on what looks like a pure-search call.
    const holder = createMockInstance(OAuthHolder);
    holder.ensureLoggedIn.mockResolvedValue(undefined);
    const handler = new StubHandler({ enabled: true });

    const { client, shutdown } = await startServerWith(
      new Map([[ToolName.LIST_TOPICS, handler]]),
      ccloudOAuthRuntime(holder),
    );
    try {
      await client.callTool({ name: ToolName.LIST_TOPICS, arguments: {} });
      expect(holder.ensureLoggedIn).not.toHaveBeenCalled();
    } finally {
      await shutdown();
    }
  });

  it("should be a no-op when runtime.oauthHolder is undefined (api_key path)", async () => {
    const handler = new StubHandler({ enabled: false });
    const handleSpy = vi.spyOn(handler, "handle");

    const { client, shutdown } = await startServerWith(
      new Map([[ToolName.LIST_TOPICS, handler]]),
      runtimeWith(), // No oauthHolder.
    );
    try {
      await client.callTool({ name: ToolName.LIST_TOPICS, arguments: {} });
      expect(handleSpy).toHaveBeenCalledOnce();
    } finally {
      await shutdown();
    }
  });

  it('should propagate ensureLoggedIn() rejection as a tool-call error and track status:"error"', async () => {
    const holder = createMockInstance(OAuthHolder);
    holder.ensureLoggedIn.mockRejectedValue(
      new Error("PKCE login timed out after 120000ms"),
    );
    const handler = new StubHandler({ enabled: false });
    const handleSpy = vi.spyOn(handler, "handle");

    const trackSpy = vi.fn();
    const { client, shutdown } = await startServerWith(
      new Map([[ToolName.LIST_TOPICS, handler]]),
      ccloudOAuthRuntime(holder),
      trackSpy,
    );
    try {
      const result = await client.callTool({
        name: ToolName.LIST_TOPICS,
        arguments: {},
      });

      // MCP SDK converts thrown errors into an error result with isError=true.
      expect(result.isError).toBe(true);
      // Handler must NOT have run — gate failure is terminal for this call.
      expect(handleSpy).not.toHaveBeenCalled();
      // Telemetry hook records the failure.
      expect(trackSpy).toHaveBeenCalledOnce();
      expect(trackSpy.mock.calls[0]![0]).toMatchObject({
        toolName: ToolName.LIST_TOPICS,
        status: "error",
      });
    } finally {
      await shutdown();
    }
  });
});
