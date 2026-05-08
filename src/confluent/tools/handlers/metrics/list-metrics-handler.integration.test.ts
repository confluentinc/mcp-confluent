import { ListMetricsHandler } from "@src/confluent/tools/handlers/metrics/list-metrics-handler.js";
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

const handler = new ListMetricsHandler();
const runtime = integrationRuntime();

describe("list-metrics-handler", { tags: [Tag.METRICS] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires telemetry.auth config", () => {});
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

    it("should expose list-metrics in tools/list", async () => {
      const { tools } = await server.client.listTools();

      expect(tools.find((t) => t.name === ToolName.LIST_METRICS)).toBeDefined();
    });

    it("should list metrics filtered by resource_type=kafka", async () => {
      const result = await server.client.callTool({
        name: ToolName.LIST_METRICS,
        arguments: { resource_type: "kafka" },
      });

      const text = textContent(result);
      // received_bytes is a stable kafka.server metric, so finding it proves the end-to-end call
      // returned kafka data
      expect(text).toMatch(/Available Metrics \(kafka\): [1-9]\d*/);
      expect(text).toContain("io.confluent.kafka.server/received_bytes");
    });
  });
});
