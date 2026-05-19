import { ListDatabasesHandler } from "@src/confluent/tools/handlers/flink/catalog/list-databases-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  trackStatementsFromMeta,
  withSharedFlinkStatementCleanup,
} from "@tests/harness/flink.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListDatabasesHandler();
const runtime = integrationRuntime();

describe("list-databases-handler", { tags: [Tag.FLINK] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires flink config", () => {});
    return;
  }

  // sweeps mcp-query-* statements surfaced via _meta.flinkStatementsCreated
  const { createdStatements } = withSharedFlinkStatementCleanup();

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should expose list-flink-databases in tools/list", async () => {
      const { tools } = await server.client.listTools();

      expect(
        tools.find((t) => t.name === ToolName.LIST_FLINK_DATABASES),
      ).toBeDefined();
    });

    it("should return databases for the configured catalog", async () => {
      const result = await server.client.callTool({
        name: ToolName.LIST_FLINK_DATABASES,
        arguments: {},
      });
      trackStatementsFromMeta(result, createdStatements);

      // fresh test account may have no databases; either response shape is valid
      expect(textContent(result)).toMatch(/^(Databases:|No databases found)/);
    });
  });
});
