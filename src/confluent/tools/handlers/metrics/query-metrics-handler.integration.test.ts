import { QueryMetricsHandler } from "@src/confluent/tools/handlers/metrics/query-metrics-handler.js";
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

const handler = new QueryMetricsHandler();
const runtime = integrationRuntime();

describe("query-metrics-handler", { tags: [Tag.METRICS] }, () => {
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

    it("should expose query-metrics in tools/list", async () => {
      const { tools } = await server.client.listTools();

      expect(
        tools.find((t) => t.name === ToolName.QUERY_METRICS),
      ).toBeDefined();
    });

    it("should query a kafka.server metric for the configured cluster", async () => {
      // `filter` is omitted: for io.confluent.kafka.server/* metrics the handler auto-injects
      // resource.kafka.id (from kafka.cluster_id in integration.yaml)
      const result = await server.client.callTool({
        name: ToolName.QUERY_METRICS,
        arguments: {
          metric: "io.confluent.kafka.server/received_bytes",
          granularity: "PT5M",
        },
      });

      expect(result.isError).not.toBe(true);
      // idle cluster may show "No data returned for metric"
      expect(textContent(result)).toMatch(
        /^(Metrics Query Results|No data returned for metric)/,
      );
    });
  });
});
