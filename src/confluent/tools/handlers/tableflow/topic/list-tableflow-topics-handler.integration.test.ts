import { ListTableFlowTopicsHandler } from "@src/confluent/tools/handlers/tableflow/topic/list-tableflow-topics-handler.js";
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

const handler = new ListTableFlowTopicsHandler();

describe(
  "list-tableflow-topics-handler",
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
  },
);
