import { GetTableInfoHandler } from "@src/confluent/tools/handlers/flink/catalog/get-table-info-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new GetTableInfoHandler();
const runtime = integrationRuntime();

describe("get-table-info-handler", { tags: [Tag.FLINK] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires flink config", () => {});
    return;
  }

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should expose get-flink-table-info in tools/list", async () => {
      const { tools } = await server.client.listTools();

      expect(
        tools.find((t) => t.name === ToolName.GET_FLINK_TABLE_INFO),
      ).toBeDefined();
    });

    // INFORMATION_SCHEMA.CATALOGS is Flink-managed and present in every workspace, so we don't need
    // to set up any tables/topics
    it("should return metadata for the INFORMATION_SCHEMA.CATALOGS meta-table", async () => {
      const result = await server.client.callTool({
        name: ToolName.GET_FLINK_TABLE_INFO,
        arguments: { tableName: "CATALOGS" },
      });

      expect(result.isError).not.toBe(true);
      expect(textContent(result)).toMatch(/^Table info for 'CATALOGS':/);
    });
  });
});
