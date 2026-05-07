import { DescribeTableHandler } from "@src/confluent/tools/handlers/flink/catalog/describe-table-handler.js";
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

const handler = new DescribeTableHandler();
const runtime = integrationRuntime();

describe("describe-table-handler", { tags: [Tag.FLINK] }, () => {
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

    it("should expose describe-flink-table in tools/list", async () => {
      const { tools } = await server.client.listTools();

      expect(
        tools.find((t) => t.name === ToolName.DESCRIBE_FLINK_TABLE),
      ).toBeDefined();
    });

    // INFORMATION_SCHEMA.CATALOGS is Flink-managed and present in every workspace, so we don't need
    // to set up any tables/topics
    it("should return the schema for the INFORMATION_SCHEMA.CATALOGS meta-table", async () => {
      const result = await server.client.callTool({
        name: ToolName.DESCRIBE_FLINK_TABLE,
        arguments: { tableName: "CATALOGS" },
      });

      expect(result.isError).not.toBe(true);
      expect(textContent(result)).toMatch(/^Table 'CATALOGS' schema:/);
    });
  });
});
