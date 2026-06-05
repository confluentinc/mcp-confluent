import { ListTableFlowRegionsHandler } from "@src/confluent/tools/handlers/tableflow/list-tableflow-regions-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { integrationConnection } from "@tests/harness/runtime.js";
import { skipIfNotEnabled } from "@tests/harness/skip-gate.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListTableFlowRegionsHandler();

describe(
  "list-tableflow-regions-handler",
  {
    tags: [
      Tag.TABLEFLOW,
      Tag.REQUIRES_TABLEFLOW_CONFIG,
      Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG,
    ],
  },
  () => {
    if (skipIfNotEnabled(handler, integrationConnection())) {
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
        // CCloud's REST surface expects uppercase cloud codes ("AWS", "GCP", "AZURE").
        const result = await server.client.callTool({
          name: ToolName.LIST_TABLEFLOW_REGIONS,
          arguments: { cloud: "AWS" },
        });

        const text = textContent(result);
        expect(text).toMatch(/^Tableflow Regions:/);
        expect(text).toContain("us-east-2");
      });

      it("should return AZURE regions when filtered by cloud=AZURE", async () => {
        const result = await server.client.callTool({
          name: ToolName.LIST_TABLEFLOW_REGIONS,
          arguments: { cloud: "AZURE" },
        });

        const text = textContent(result);
        expect(text).toMatch(/^Tableflow Regions:/);
        expect(text).toContain("eastus2");
      });

      it("should return GCP regions when filtered by cloud=GCP", async (ctx) => {
        // CCloud has no GCP tableflow regions today (call returns total_size=0). Skip rather than
        // fail so this auto-validates when GCP lands. A real "filter ignored" regression isn't
        // masked: total_size > 0 bypasses the skip, and the GCP cloud assertion catches it.
        const result = await server.client.callTool({
          name: ToolName.LIST_TABLEFLOW_REGIONS,
          arguments: { cloud: "GCP" },
        });

        const text = textContent(result);
        expect(text).toMatch(/^Tableflow Regions:/);
        if (/"total_size":0\b/.test(text)) {
          ctx.skip("CCloud has no GCP tableflow regions configured");
        }
        expect(text).toMatch(/"cloud":"GCP"/);
      });

      it("should succeed when cloud is omitted", async () => {
        // regression for #129: omitted cloud must not send `?cloud=undefined`, which CCloud rejects
        // with 400. The success-prefix match below is the regression guard.
        const result = await server.client.callTool({
          name: ToolName.LIST_TABLEFLOW_REGIONS,
          arguments: {},
        });

        const text = textContent(result);
        expect(text).toMatch(/^Tableflow Regions:/);
        expect(text).toMatch(/"cloud":"AWS"/);
        // FUTURE: update this test when CCloud returns multiple cloud providers when `cloud` isn't
        // specified
      });
    });
  },
);
