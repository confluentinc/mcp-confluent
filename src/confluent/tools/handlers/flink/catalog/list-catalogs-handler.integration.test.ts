import { ListCatalogsHandler } from "@src/confluent/tools/handlers/flink/catalog/list-catalogs-handler.js";
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

const handler = new ListCatalogsHandler();
const runtime = integrationRuntime();

describe(
  "list-catalogs-handler",
  {
    tags: [
      Tag.FLINK,
      Tag.REQUIRES_FLINK_CONFIG,
      Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG,
    ],
  },
  () => {
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

      it("should expose list-flink-catalogs in tools/list", async () => {
        const { tools } = await server.client.listTools();

        expect(
          tools.find((t) => t.name === ToolName.LIST_FLINK_CATALOGS),
        ).toBeDefined();
      });

      it("should return at least the configured environment as a catalog", async () => {
        const result = await server.client.callTool({
          name: ToolName.LIST_FLINK_CATALOGS,
          arguments: {},
        });
        trackStatementsFromMeta(result, createdStatements);

        expect(textContent(result)).toMatch(/^Catalogs:/);
      });
    });
  },
);
