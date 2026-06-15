import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import { ToolHandler } from "@src/confluent/tools/base-tools.js";
import {
  hasKafka,
  kafkaBootstrapOrOAuth,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import { initEnv } from "@src/env.js";
import { createMcpServer, type ToolCallProps } from "@src/mcp/server.js";
import { ServerRuntime } from "@src/server-runtime.js";
import {
  ccloudOAuthRuntime,
  localPlusOAuthRuntime,
  runtimeWith,
  runtimeWithConnections,
} from "@tests/factories/runtime.js";
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
  let activeShutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await activeShutdown?.();
    activeShutdown = undefined;
  });

  // Boots a single-tool server and registers its teardown with the afterEach
  // above, so individual tests don't carry their own try/finally shutdown.
  async function startWith(
    handler: ToolHandler,
    runtime: ServerRuntime,
    track?: (props: ToolCallProps) => void,
  ): Promise<Client> {
    const { client, shutdown } = await startServerWith(
      new Map([[ToolName.LIST_TOPICS, handler]]),
      runtime,
      track,
    );
    activeShutdown = shutdown;
    return client;
  }

  it("should call ensureLoggedIn() before handle() when the call routes to the OAuth connection", async () => {
    const holder = createMockInstance(OAuthHolder);
    holder.ensureLoggedIn.mockResolvedValue(undefined);
    // Enabled on the sole OAuth connection, so the call unambiguously routes there.
    const handler = new StubHandler({ predicate: kafkaBootstrapOrOAuth });

    const client = await startWith(handler, ccloudOAuthRuntime(holder));
    await client.callTool({ name: ToolName.LIST_TOPICS, arguments: {} });

    expect(holder.ensureLoggedIn).toHaveBeenCalledOnce();
  });

  it("should NOT call ensureLoggedIn() when the call routes to a local direct connection in a mixed config", async () => {
    // The bug: invoking a local-only tool in a local+OAuth config used to launch
    // the browser anyway, because the old gate fired whenever an OAuth holder
    // merely existed. A `hasKafka` tool is enabled only on the local connection,
    // so the call routes to direct — no OAuth login is needed.
    const holder = createMockInstance(OAuthHolder);
    holder.ensureLoggedIn.mockResolvedValue(undefined);
    const handler = new StubHandler({ predicate: hasKafka });

    const client = await startWith(handler, localPlusOAuthRuntime(holder));
    await client.callTool({ name: ToolName.LIST_TOPICS, arguments: {} });

    expect(holder.ensureLoggedIn).not.toHaveBeenCalled();
  });

  it("should call ensureLoggedIn() when a both-connections tool is explicitly routed to the OAuth connection", async () => {
    const holder = createMockInstance(OAuthHolder);
    holder.ensureLoggedIn.mockResolvedValue(undefined);
    const handler = new StubHandler({ predicate: kafkaBootstrapOrOAuth });

    const client = await startWith(handler, localPlusOAuthRuntime(holder));
    await client.callTool({
      name: ToolName.LIST_TOPICS,
      arguments: { connectionId: "ccloud-oauth" },
    });

    expect(holder.ensureLoggedIn).toHaveBeenCalledOnce();
  });

  it("should NOT call ensureLoggedIn() when a both-connections tool is explicitly routed to the local connection", async () => {
    const holder = createMockInstance(OAuthHolder);
    holder.ensureLoggedIn.mockResolvedValue(undefined);
    const handler = new StubHandler({ predicate: kafkaBootstrapOrOAuth });

    const client = await startWith(handler, localPlusOAuthRuntime(holder));
    await client.callTool({
      name: ToolName.LIST_TOPICS,
      arguments: { connectionId: "local" },
    });

    expect(holder.ensureLoggedIn).not.toHaveBeenCalled();
  });

  it("should NOT call ensureLoggedIn() when handler.predicate is alwaysEnabled (e.g., docs lookups)", async () => {
    // Doc-lookup tools have predicate = alwaysEnabled and never touch the
    // OAuth client manager. Gating them would surprise the user with a
    // browser tab on what looks like a pure-search call.
    const holder = createMockInstance(OAuthHolder);
    holder.ensureLoggedIn.mockResolvedValue(undefined);
    const handler = new StubHandler({ enabled: true });

    const client = await startWith(handler, ccloudOAuthRuntime(holder));
    await client.callTool({ name: ToolName.LIST_TOPICS, arguments: {} });

    expect(holder.ensureLoggedIn).not.toHaveBeenCalled();
  });

  it("should be a no-op when runtime.oauthHolder is undefined (api_key path)", async () => {
    // A normally-enabled tool that routes cleanly to the sole connection; the
    // gate must skip the OAuth branch purely because no holder exists.
    const handler = new StubHandler({ predicate: hasKafka });
    const handleSpy = vi.spyOn(handler, "handle");

    const client = await startWith(
      handler,
      runtimeWith({ kafka: { bootstrap_servers: "b:9092" } }), // No oauthHolder.
    );
    await client.callTool({ name: ToolName.LIST_TOPICS, arguments: {} });

    expect(handleSpy).toHaveBeenCalledOnce();
  });

  it('should propagate ensureLoggedIn() rejection as a tool-call error and track status:"error"', async () => {
    const holder = createMockInstance(OAuthHolder);
    holder.ensureLoggedIn.mockRejectedValue(
      new Error("PKCE login timed out after 120000ms"),
    );
    const handler = new StubHandler({ predicate: kafkaBootstrapOrOAuth });
    const handleSpy = vi.spyOn(handler, "handle");
    const trackSpy = vi.fn();

    const client = await startWith(
      handler,
      ccloudOAuthRuntime(holder),
      trackSpy,
    );
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
  });
});

describe("createMcpServer registered schema", () => {
  // A connection-gated tool viable on both connections, so
  // getRegisteredToolConfig() injects a required connectionId enum.
  const twoKafka = () =>
    runtimeWithConnections({
      "conn-a": { kafka: { bootstrap_servers: "a:9092" } },
      "conn-b": { kafka: { bootstrap_servers: "b:9092" } },
    });

  let activeShutdown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await activeShutdown?.();
    activeShutdown = undefined;
  });

  // Boots a one-tool server and registers its teardown with the afterEach above,
  // so individual tests don't carry their own try/finally shutdown.
  async function startWith(
    handler: ToolHandler,
    runtime: ServerRuntime,
  ): Promise<Client> {
    const { client, shutdown } = await startServerWith(
      new Map([[ToolName.LIST_TOPICS, handler]]),
      runtime,
    );
    activeShutdown = shutdown;
    return client;
  }

  // Proves the registration path advertises getRegisteredToolConfig() — not the
  // raw authored getToolConfig() — by exercising the connectionId injection: a
  // connection-gated tool viable on more than one connection gains a routing
  // connectionId enum.
  it("should advertise a required connectionId enum for a connection-gated tool viable on multiple connections", async () => {
    const client = await startWith(
      ToolHandlerRegistry.getToolHandler(ToolName.LIST_TOPICS),
      twoKafka(),
    );

    const { tools } = await client.listTools();
    const listTopics = tools.find((t) => t.name === ToolName.LIST_TOPICS);
    const properties = listTopics?.inputSchema?.properties as
      | Record<string, { enum?: string[] }>
      | undefined;

    expect(properties?.connectionId?.enum).toEqual(["conn-a", "conn-b"]);
    expect(listTopics?.inputSchema?.required).toContain("connectionId");
  });

  // The injected enum is required and value-constrained, so the SDK rejects a
  // missing/unknown connectionId before the handler runs — the guarantee the
  // consume side (#534) leans on.
  it.each([
    ["a missing", {}],
    ["an unknown", { connectionId: "conn-x" }],
  ])(
    "should reject %s connectionId before handle() runs",
    async (_label, args) => {
      const handler = new StubHandler({ predicate: hasKafka });
      const handleSpy = vi.spyOn(handler, "handle");
      const client = await startWith(handler, twoKafka());

      const result = await client.callTool({
        name: ToolName.LIST_TOPICS,
        arguments: args,
      });

      expect(result.isError).toBe(true);
      expect(handleSpy).not.toHaveBeenCalled();
    },
  );

  it("should run handle() when connectionId names a viable connection", async () => {
    const handler = new StubHandler({ predicate: hasKafka });
    const handleSpy = vi.spyOn(handler, "handle");
    const client = await startWith(handler, twoKafka());

    await client.callTool({
      name: ToolName.LIST_TOPICS,
      arguments: { connectionId: "conn-a" },
    });

    expect(handleSpy).toHaveBeenCalledOnce();
  });

  // #590, part 2: the registered schema is strict, so an unknown parameter is
  // rejected before handle() runs rather than silently stripped. A single-
  // connection server (no connectionId injected) proves the strictness is a
  // property of the registration boundary, not of the connectionId injection.
  const oneKafka = () =>
    runtimeWith({ kafka: { bootstrap_servers: "a:9092" } });

  it("should reject an unknown parameter before handle() runs on a single-connection server", async () => {
    const handler = new StubHandler({ predicate: hasKafka });
    const handleSpy = vi.spyOn(handler, "handle");
    const client = await startWith(handler, oneKafka());

    const result = await client.callTool({
      name: ToolName.LIST_TOPICS,
      arguments: { bogusParam: "nope" },
    });

    expect(result.isError).toBe(true);
    expect(handleSpy).not.toHaveBeenCalled();
  });

  it("should advertise additionalProperties:false on the registered input schema", async () => {
    const client = await startWith(
      new StubHandler({ predicate: hasKafka }),
      oneKafka(),
    );

    const { tools } = await client.listTools();
    const listTopics = tools.find((t) => t.name === ToolName.LIST_TOPICS);

    expect(listTopics?.inputSchema?.additionalProperties).toBe(false);
  });
});
