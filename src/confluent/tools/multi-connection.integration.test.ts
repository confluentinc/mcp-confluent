import { KafkaJS } from "@confluentinc/kafka-javascript";
import {
  type ConnectionConfig,
  type DirectConnectionConfig,
} from "@src/config/models.js";
import { ListFlinkStatementsHandler } from "@src/confluent/tools/handlers/flink/list-flink-statements-handler.js";
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { connectAdminForConnection } from "@tests/harness/multi-kafka-admin.js";
import {
  CCLOUD_CONNECTION_ID,
  CP_CONNECTION_ID,
  multiIntegrationConnection,
  multiIntegrationConnectionsLoaded,
} from "@tests/harness/multi-runtime.js";
import {
  startMultiServer,
  type StartedServer,
} from "@tests/harness/multi-start-server.js";
import { skipIfDisabled } from "@tests/harness/skip-gate.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const listTopicsHandler = new ListTopicsHandler();
const listFlinkStatementsHandler = new ListFlinkStatementsHandler();

/** Narrows a fixture connection to direct for the test-side admin builder. */
function asDirect(conn: ConnectionConfig): DirectConnectionConfig {
  if (conn.type !== "direct") {
    throw new Error(
      `Expected multi-fixture connection to be direct; got "${conn.type}"`,
    );
  }
  return conn;
}

/** The JSON-schema view of an injected `connectionId` param, as `tools/list` exposes it. */
interface ConnectionIdSchema {
  enum?: string[];
  description?: string;
}

/**
 * The #543 multi-connection suite: one server holding two `direct` connections —
 * `ccloud` (the sole Flink-capable connection) and `cp` (the local Confluent
 * Platform broker, kafka only). Proves, against live infrastructure, that tool
 * calls route to the addressed connection and that per-tool connection
 * candidacy is advertised and enforced correctly on a multi-connection server.
 */
describe("multi-connection routing", { tags: [Tag.MULTI] }, () => {
  // Both connections must load (both clusters' creds present) before any test
  // can spawn the two-connection server.
  if (!multiIntegrationConnectionsLoaded()) {
    it.skip("requires both ccloud and cp connections configured in integration.multi.yaml (CCloud creds + a running docker-compose.cp-test.yml stack)", () => {});
    return;
  }
  // Each connection independently satisfies the predicate of the tool that
  // routes to it; the Flink assertions additionally need ccloud's flink block.
  if (
    skipIfDisabled(
      listTopicsHandler,
      multiIntegrationConnection(CCLOUD_CONNECTION_ID),
    )
  ) {
    return;
  }
  if (
    skipIfDisabled(
      listTopicsHandler,
      multiIntegrationConnection(CP_CONNECTION_ID),
    )
  ) {
    return;
  }
  if (
    skipIfDisabled(
      listFlinkStatementsHandler,
      multiIntegrationConnection(CCLOUD_CONNECTION_ID),
    )
  ) {
    return;
  }

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;
    let ccloudAdmin: KafkaJS.Admin;
    let cpAdmin: KafkaJS.Admin;
    const ccloudTopic = uniqueName("multi-ccloud");
    const cpTopic = uniqueName("multi-cp");

    beforeAll(async () => {
      server = await startMultiServer({ transport });
      ccloudAdmin = await connectAdminForConnection(
        asDirect(multiIntegrationConnection(CCLOUD_CONNECTION_ID)),
        "mcp-confluent-multi-it-ccloud",
      );
      cpAdmin = await connectAdminForConnection(
        asDirect(multiIntegrationConnection(CP_CONNECTION_ID)),
        "mcp-confluent-multi-it-cp",
      );
      // One distinct topic per cluster so the two list-topics responses are
      // provably different sets, not just the same set fetched twice.
      await ccloudAdmin.createTopics({
        topics: [{ topic: ccloudTopic, numPartitions: 1 }],
      });
      await cpAdmin.createTopics({
        topics: [{ topic: cpTopic, numPartitions: 1 }],
      });
    });

    afterAll(async () => {
      await ccloudAdmin
        ?.deleteTopics({ topics: [ccloudTopic] })
        .catch(() => {});
      await cpAdmin?.deleteTopics({ topics: [cpTopic] }).catch(() => {});
      await ccloudAdmin?.disconnect().catch(() => {});
      await cpAdmin?.disconnect().catch(() => {});
      await server?.stop();
    });

    /** Returns the error text of a tool call that must fail, whether it rejects (SDK input validation) or returns `isError` (handler). Fails loudly if the call unexpectedly succeeds. */
    async function callToolError(
      name: ToolName,
      args: Record<string, unknown>,
    ): Promise<string> {
      // Typed (not bare `let result`, which would be implicit any). The expect
      // stays *outside* the try so a wrongly-successful call fails the test
      // rather than having its AssertionError caught and returned as a string.
      let result: Awaited<ReturnType<typeof server.client.callTool>>;
      try {
        result = await server.client.callTool({ name, arguments: args });
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      expect(
        result.isError,
        `expected ${name} to error; got: ${textContent(result)}`,
      ).toBe(true);
      return textContent(result);
    }

    /** The injected `connectionId` schema for `toolName` from `tools/list`, or undefined. */
    async function connectionIdSchema(
      toolName: ToolName,
    ): Promise<ConnectionIdSchema | undefined> {
      const { tools } = await server.client.listTools();
      const tool = tools.find((t) => t.name === toolName);
      const props = tool?.inputSchema?.properties as
        | Record<string, ConnectionIdSchema>
        | undefined;
      return props?.connectionId;
    }

    /** Whether `tools/list` marks `connectionId` required on `toolName`. */
    async function connectionIdRequired(toolName: ToolName): Promise<boolean> {
      const { tools } = await server.client.listTools();
      const tool = tools.find((t) => t.name === toolName);
      const required = tool?.inputSchema?.required as string[] | undefined;
      return required?.includes("connectionId") ?? false;
    }

    // --- Assertion 1: Kafka routing ---

    it("should route list-topics to the addressed connection, with distinct topic sets per cluster", async () => {
      const ccloudText = textContent(
        await server.client.callTool({
          name: ToolName.LIST_TOPICS,
          arguments: { connectionId: CCLOUD_CONNECTION_ID },
        }),
      );
      expect(ccloudText, ccloudText).toContain(ccloudTopic);
      expect(ccloudText).not.toContain(cpTopic);

      const cpText = textContent(
        await server.client.callTool({
          name: ToolName.LIST_TOPICS,
          arguments: { connectionId: CP_CONNECTION_ID },
        }),
      );
      expect(cpText, cpText).toContain(cpTopic);
      expect(cpText).not.toContain(ccloudTopic);
    });

    it("should advertise both connections as list-topics candidates and require an explicit choice", async () => {
      expect(await connectionIdRequired(ToolName.LIST_TOPICS)).toBe(true);
      const schema = await connectionIdSchema(ToolName.LIST_TOPICS);
      expect(schema?.enum?.slice().sort((a, b) => a.localeCompare(b))).toEqual([
        CCLOUD_CONNECTION_ID,
        CP_CONNECTION_ID,
      ]);
      // both candidate ids surface in the description that steers the agent
      expect(schema?.description).toContain(CCLOUD_CONNECTION_ID);
      expect(schema?.description).toContain(CP_CONNECTION_ID);
    });

    it("should reject list-topics when connectionId is omitted", async () => {
      const message = await callToolError(ToolName.LIST_TOPICS, {});
      expect(message).toContain("connectionId");
    });

    // --- Assertion 2 (reframed per #590): per-tool candidate narrowing ---
    //
    // #590 makes a multi-connection server inject a *required* connectionId enum
    // narrowed to the tool's viable candidates. Flink's enum is ["ccloud"] only,
    // so omitting it errors and "cp" is not an accepted value. Do NOT "fix" these
    // to expect auto-routing — that pre-#590 behavior only holds on a
    // single-connection server.

    it("should narrow list-flink-statements' connectionId enum to the flink-capable connection only", async () => {
      expect(await connectionIdRequired(ToolName.LIST_FLINK_STATEMENTS)).toBe(
        true,
      );
      const schema = await connectionIdSchema(ToolName.LIST_FLINK_STATEMENTS);
      expect(schema?.enum).toEqual([CCLOUD_CONNECTION_ID]);
    });

    it("should resolve list-flink-statements against the flink-capable connection", async () => {
      const result = await server.client.callTool({
        name: ToolName.LIST_FLINK_STATEMENTS,
        arguments: { connectionId: CCLOUD_CONNECTION_ID },
      });
      expect(result.isError, textContent(result)).not.toBe(true);
    });

    it("should reject list-flink-statements addressed to the non-flink connection", async () => {
      const message = await callToolError(ToolName.LIST_FLINK_STATEMENTS, {
        connectionId: CP_CONNECTION_ID,
      });
      // Zod v4's invalid_value issue names the *accepted* value, never the
      // rejected input, so the message can't echo "cp". It proves the rejection
      // by naming the connectionId field and ccloud as the sole accepted value
      // — the narrowed enum enforced at call time, not just advertised in
      // tools/list.
      expect(message).toContain("connectionId");
      expect(message).toContain(CCLOUD_CONNECTION_ID);
    });

    // --- Assertion 3: discovery tools report both connections correctly ---

    it("should list both connections with flink tools enabled on ccloud only", async () => {
      const result = await server.client.callTool({
        name: ToolName.LIST_CONFIGURED_CONNECTIONS,
        arguments: {},
      });
      expect(result.isError, textContent(result)).not.toBe(true);

      const { connections } = result.structuredContent as {
        connections: Record<string, { enabledTools: string[] }>;
      };
      expect(
        Object.keys(connections).sort((a, b) => a.localeCompare(b)),
      ).toEqual([CCLOUD_CONNECTION_ID, CP_CONNECTION_ID]);

      const ccloudTools = connections[CCLOUD_CONNECTION_ID]?.enabledTools ?? [];
      const cpTools = connections[CP_CONNECTION_ID]?.enabledTools ?? [];
      expect(ccloudTools).toContain(ToolName.LIST_FLINK_STATEMENTS);
      expect(ccloudTools).toContain(ToolName.LIST_TOPICS);
      expect(cpTools).toContain(ToolName.LIST_TOPICS);
      expect(cpTools).not.toContain(ToolName.LIST_FLINK_STATEMENTS);
    });

    it("should describe each connection's blocks, exposing flink on ccloud only", async () => {
      const ccloudCard = (
        await server.client.callTool({
          name: ToolName.DESCRIBE_CONFIGURED_CONNECTION,
          arguments: { connectionId: CCLOUD_CONNECTION_ID },
        })
      ).structuredContent as {
        blocks: Record<string, unknown>;
        enabledTools: string[];
      };
      expect(ccloudCard.blocks).toHaveProperty("kafka");
      expect(ccloudCard.blocks).toHaveProperty("flink");
      expect(ccloudCard.enabledTools).toContain(ToolName.LIST_FLINK_STATEMENTS);

      const cpCard = (
        await server.client.callTool({
          name: ToolName.DESCRIBE_CONFIGURED_CONNECTION,
          arguments: { connectionId: CP_CONNECTION_ID },
        })
      ).structuredContent as {
        blocks: Record<string, unknown>;
        enabledTools: string[];
      };
      expect(cpCard.blocks).toHaveProperty("kafka");
      expect(cpCard.blocks).not.toHaveProperty("flink");
      expect(cpCard.enabledTools).not.toContain(ToolName.LIST_FLINK_STATEMENTS);
    });
  });
});
