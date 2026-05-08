import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import type { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  type ToolConfig,
  type ToolHandler,
} from "@src/confluent/tools/base-tools.js";
import {
  alwaysEnabled,
  ToolDisabledReason,
  type ConnectionPredicate,
} from "@src/confluent/tools/connection-predicates.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { initEnv } from "@src/env.js";
import { createMcpServer, type ToolCallProps } from "@src/mcp/server.js";
import { ServerRuntime } from "@src/server-runtime.js";
import { runtimeWith } from "@tests/factories/runtime.js";
import { createTestServer, TestServerContext } from "@tests/server.js";
import { createMockInstance } from "@tests/stubs/index.js";
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
});

/**
 * Concrete BaseToolHandler with a configurable predicate, used to drive
 * gate-behavior tests without depending on the shape of any one production
 * handler. Records every {@linkcode handle} invocation so tests can assert
 * gate-vs-handle ordering.
 */
class GateTestHandler extends BaseToolHandler {
  readonly handleSpy = vi.fn();
  readonly predicate: ConnectionPredicate;

  constructor(
    private readonly toolName: ToolName,
    predicate: ConnectionPredicate,
  ) {
    super();
    // Explicit assignment (rather than a parameter property) because
    // BaseToolHandler declares `predicate` abstract; with
    // useDefineForClassFields=true a subclass parameter property would be
    // shadowed by the base's class-field declaration.
    this.predicate = predicate;
  }

  getToolConfig(): ToolConfig {
    return {
      name: this.toolName,
      description: "test",
      inputSchema: {},
      annotations: READ_ONLY,
    };
  }

  handle(): CallToolResult {
    this.handleSpy();
    return this.createResponse("ok");
  }
}

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
  // Distinct from `alwaysEnabled` so the gate fires for the test handler;
  // the actual return value doesn't matter (the gate doesn't call the
  // predicate, only compares against `alwaysEnabled`).
  const stubPredicate: ConnectionPredicate = () => ({
    enabled: false,
    reason: ToolDisabledReason.MissingFlinkBlock,
  });

  it("should call ensureLoggedIn() before handle() when an OAuth holder is present and predicate is not alwaysEnabled", async () => {
    const holder = createMockInstance(OAuthHolder);
    holder.ensureLoggedIn.mockResolvedValue(undefined);
    const handler = new GateTestHandler(ToolName.LIST_TOPICS, stubPredicate);

    const runtime = runtimeWith();
    Object.defineProperty(runtime, "oauthHolder", {
      value: holder,
      configurable: true,
    });

    const { client, shutdown } = await startServerWith(
      new Map([[ToolName.LIST_TOPICS, handler]]),
      runtime,
    );
    try {
      await client.callTool({ name: ToolName.LIST_TOPICS, arguments: {} });

      expect(holder.ensureLoggedIn).toHaveBeenCalledOnce();
      expect(handler.handleSpy).toHaveBeenCalledOnce();
      // Order matters: gate must run before handle.
      expect(holder.ensureLoggedIn.mock.invocationCallOrder[0]).toBeLessThan(
        handler.handleSpy.mock.invocationCallOrder[0]!,
      );
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
    const handler = new GateTestHandler(
      ToolName.SEARCH_PRODUCT_DOCS,
      alwaysEnabled,
    );

    const runtime = runtimeWith();
    Object.defineProperty(runtime, "oauthHolder", {
      value: holder,
      configurable: true,
    });

    const { client, shutdown } = await startServerWith(
      new Map([[ToolName.SEARCH_PRODUCT_DOCS, handler]]),
      runtime,
    );
    try {
      await client.callTool({
        name: ToolName.SEARCH_PRODUCT_DOCS,
        arguments: {},
      });
      expect(holder.ensureLoggedIn).not.toHaveBeenCalled();
      expect(handler.handleSpy).toHaveBeenCalledOnce();
    } finally {
      await shutdown();
    }
  });

  it("should be a no-op when runtime.oauthHolder is undefined (api_key path)", async () => {
    const handler = new GateTestHandler(ToolName.LIST_TOPICS, stubPredicate);
    const runtime = runtimeWith(); // No oauthHolder.
    expect(runtime.oauthHolder).toBeUndefined();

    const { client, shutdown } = await startServerWith(
      new Map([[ToolName.LIST_TOPICS, handler]]),
      runtime,
    );
    try {
      await client.callTool({ name: ToolName.LIST_TOPICS, arguments: {} });
      expect(handler.handleSpy).toHaveBeenCalledOnce();
    } finally {
      await shutdown();
    }
  });

  it('should propagate ensureLoggedIn() rejection as a tool-call error and track status:"error"', async () => {
    const holder = createMockInstance(OAuthHolder);
    holder.ensureLoggedIn.mockRejectedValue(
      new Error("PKCE login timed out after 120000ms"),
    );
    const handler = new GateTestHandler(ToolName.LIST_TOPICS, stubPredicate);

    const runtime = runtimeWith();
    Object.defineProperty(runtime, "oauthHolder", {
      value: holder,
      configurable: true,
    });

    const trackSpy = vi.fn();
    const { client, shutdown } = await startServerWith(
      new Map([[ToolName.LIST_TOPICS, handler]]),
      runtime,
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
      expect(handler.handleSpy).not.toHaveBeenCalled();
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
