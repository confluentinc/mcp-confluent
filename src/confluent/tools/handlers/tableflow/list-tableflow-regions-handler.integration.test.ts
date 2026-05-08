import { ListTableFlowRegionsHandler } from "@src/confluent/tools/handlers/tableflow/list-tableflow-regions-handler.js";
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

const handler = new ListTableFlowRegionsHandler();
const runtime = integrationRuntime();

describe("list-tableflow-regions-handler", { tags: [Tag.TABLEFLOW] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires tableflow.auth config", () => {});
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

    it("should expose list-tableflow-regions in tools/list", async () => {
      const { tools } = await server.client.listTools();

      expect(
        tools.find((t) => t.name === ToolName.LIST_TABLEFLOW_REGIONS),
      ).toBeDefined();
    });

    it("should return AWS regions when filtered by cloud=AWS", async () => {
      // pass `cloud` explicitly: omitting it sends the literal string "undefined" to the API
      // (issue #129). once that lands we can drop the arg. CCloud's REST surface expects
      // uppercase cloud codes ("AWS", "GCP", "AZURE").
      const result = await server.client.callTool({
        name: ToolName.LIST_TABLEFLOW_REGIONS,
        arguments: { cloud: "AWS" },
      });

      expect(result.isError).not.toBe(true);
      const text = textContent(result);
      expect(text).toMatch(/^Tableflow Regions:/);
      expect(text).toContain("us-east-2");
    });
  });
});
