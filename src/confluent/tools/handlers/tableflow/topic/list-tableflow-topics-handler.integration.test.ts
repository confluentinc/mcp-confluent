import { ListTableFlowTopicsHandler } from "@src/confluent/tools/handlers/tableflow/topic/list-tableflow-topics-handler.js";
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

const handler = new ListTableFlowTopicsHandler();
const runtime = integrationRuntime();

describe("list-tableflow-topics-handler", { tags: [Tag.TABLEFLOW] }, () => {
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

    it("should expose list-tableflow-topics in tools/list", async () => {
      const { tools } = await server.client.listTools();

      expect(
        tools.find((t) => t.name === ToolName.LIST_TABLEFLOW_TOPICS),
      ).toBeDefined();
    });

    it("should list tableflow topics for the configured cluster", async () => {
      // omit env/cluster args: handler falls back to kafka.env_id and kafka.cluster_id from
      // the YAML fixture. an empty data array is a valid happy-path response when no kafka topics
      // have tableflow enabled in the test cluster.
      const result = await server.client.callTool({
        name: ToolName.LIST_TABLEFLOW_TOPICS,
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(textContent(result)).toMatch(/^Tableflow Topics:/);
    });
  });
});
