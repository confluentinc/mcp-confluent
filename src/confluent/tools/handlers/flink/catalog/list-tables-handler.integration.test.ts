import { ListTablesHandler } from "@src/confluent/tools/handlers/flink/catalog/list-tables-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  trackStatementsFromMeta,
  withSharedFlinkStatementCleanup,
} from "@tests/harness/flink.js";
import { integrationConnection } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListTablesHandler();

describe(
  "list-tables-handler",
  {
    tags: [
      Tag.FLINK,
      Tag.REQUIRES_FLINK_CONFIG,
      Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG,
    ],
  },
  () => {
    const verdict = handler.predicate(integrationConnection());
    if (!verdict.enabled) {
      it.skip(verdict.reason, () => {});
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

      it("should expose list-flink-tables in tools/list", async () => {
        const { tools } = await server.client.listTools();

        expect(
          tools.find((t) => t.name === ToolName.LIST_FLINK_TABLES),
        ).toBeDefined();
      });

      it("should return tables (or the empty-set string) for the configured catalog", async () => {
        const result = await server.client.callTool({
          name: ToolName.LIST_FLINK_TABLES,
          arguments: {},
        });
        trackStatementsFromMeta(result, createdStatements);

        // handler filters out INFORMATION_SCHEMA; a fresh env may have no user tables
        expect(textContent(result)).toMatch(
          /^(Tables in catalog|No tables found)/,
        );
      });
    });
  },
);
