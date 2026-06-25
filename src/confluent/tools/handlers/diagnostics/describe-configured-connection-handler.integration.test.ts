import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  integrationConnectionId,
  integrationConnectionLoaded,
} from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * describe-configured-connection is connection-agnostic — it introspects the
 * server's own config and makes no Confluent Cloud calls — so it rides the
 * @smoke lane and gates on "did any connection load?" rather than a per-service
 * predicate, the same shape the transport smoke tests use.
 */
describe("describe-configured-connection", { tags: [Tag.SMOKE] }, () => {
  if (!integrationConnectionLoaded()) {
    it.skip("requires at least one configured connection in integration.yaml", () => {});
    return;
  }

  const connectionId = integrationConnectionId();

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should describe the configured connection's non-secret card and enabled tools", async () => {
      const result = await server.client.callTool({
        name: ToolName.DESCRIBE_CONFIGURED_CONNECTION,
        arguments: { connectionId },
      });

      expect(result.isError, textContent(result)).not.toBe(true);

      const card = result.structuredContent as {
        connectionId: string;
        type: string;
        readOnly: boolean;
        blocks: { kafka?: Record<string, unknown> };
        enabledTools: string[];
      };

      expect(card.connectionId).toBe(connectionId);
      expect(card.type).toBe("direct");
      expect(card.readOnly).toBe(false);
      // cluster_id is a non-secret literal straight from the fixture's kafka block.
      expect(card.blocks.kafka?.cluster_id).toBe("lkc-dm5vyd");
      expect(card.enabledTools).toContain(ToolName.LIST_TOPICS);
    });

    it("should never surface auth credentials on the wire", async () => {
      const result = await server.client.callTool({
        name: ToolName.DESCRIBE_CONFIGURED_CONNECTION,
        arguments: { connectionId },
      });

      const card = result.structuredContent as {
        blocks: { kafka?: Record<string, unknown> };
      };
      expect(card.blocks.kafka).not.toHaveProperty("auth");
      // No credential-named field anywhere in the serialized card.
      expect(JSON.stringify(result.structuredContent)).not.toMatch(
        /"(auth|secret|password)"/,
      );
    });

    it("should error and name the valid id for an unknown connection id", async () => {
      const result = await server.client.callTool({
        name: ToolName.DESCRIBE_CONFIGURED_CONNECTION,
        arguments: { connectionId: "does-not-exist" },
      });

      expect(result.isError).toBe(true);
      expect(textContent(result)).toContain(`"${connectionId}"`);
    });
  });
});
