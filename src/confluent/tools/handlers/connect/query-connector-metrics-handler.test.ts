import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { QueryConnectorMetricsHandler } from "@src/confluent/tools/handlers/connect/query-connector-metrics-handler.js";
import { QueryMetricsHandler } from "@src/confluent/tools/handlers/metrics/query-metrics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { TELEMETRY_REQUIRED_ENV_VARS } from "@src/env-schema.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";

describe("query-connector-metrics-handler.ts", () => {
  describe("QueryConnectorMetricsHandler", () => {
    describe("getToolConfig()", () => {
      it("should return QUERY_CONNECTOR_METRICS with READ_ONLY annotations", () => {
        const handler = new QueryConnectorMetricsHandler();
        const config = handler.getToolConfig();

        expect(config.name).toBe(ToolName.QUERY_CONNECTOR_METRICS);
        expect(config.annotations).toBe(READ_ONLY);
        expect(config.description).toContain("connector");
      });
    });

    describe("getRequiredEnvVars()", () => {
      it("should return TELEMETRY_REQUIRED_ENV_VARS", () => {
        const handler = new QueryConnectorMetricsHandler();

        expect(handler.getRequiredEnvVars()).toBe(TELEMETRY_REQUIRED_ENV_VARS);
      });
    });

    describe("isConfluentCloudOnly()", () => {
      it("should return true", () => {
        const handler = new QueryConnectorMetricsHandler();

        expect(handler.isConfluentCloudOnly()).toBe(true);
      });
    });

    describe("handle()", () => {
      it("should delegate to QueryMetricsHandler with auto-injected connector filter", async () => {
        const handler = new QueryConnectorMetricsHandler();
        const clientManager = createMockInstance(DefaultClientManager);
        const innerHandle = vi
          .spyOn(handler["inner"] as QueryMetricsHandler, "handle")
          .mockResolvedValue({
            content: [{ type: "text", text: "stub" }],
            isError: false,
          });

        const result = await handler.handle(clientManager, {
          connectorId: "lcc-abc123",
          metric: "io.confluent.kafka.connect/sent_records",
        });

        expect(innerHandle).toHaveBeenCalledOnce();
        expect(innerHandle).toHaveBeenCalledWith(
          clientManager,
          expect.objectContaining({
            metric: "io.confluent.kafka.connect/sent_records",
            filter: { "resource.connector.id": "lcc-abc123" },
          }),
        );
        const callArgs = innerHandle.mock.calls[0]![1] as Record<
          string,
          unknown
        >;
        expect(callArgs).not.toHaveProperty("connectorId");
        expect(result).toEqual({
          content: [{ type: "text", text: "stub" }],
          isError: false,
        });
      });

      it("should preserve user-provided filter keys and merge in resource.connector.id", async () => {
        const handler = new QueryConnectorMetricsHandler();
        const clientManager = createMockInstance(DefaultClientManager);
        const innerHandle = vi
          .spyOn(handler["inner"] as QueryMetricsHandler, "handle")
          .mockResolvedValue({
            content: [{ type: "text", text: "stub" }],
            isError: false,
          });

        await handler.handle(clientManager, {
          connectorId: "lcc-abc123",
          metric: "io.confluent.kafka.connect/sent_records",
          filter: { "resource.environment.id": "env-xyz" },
        });

        expect(innerHandle).toHaveBeenCalledWith(
          clientManager,
          expect.objectContaining({
            filter: {
              "resource.environment.id": "env-xyz",
              "resource.connector.id": "lcc-abc123",
            },
          }),
        );
      });

      it("should override user-provided resource.connector.id with the connectorId arg", async () => {
        const handler = new QueryConnectorMetricsHandler();
        const clientManager = createMockInstance(DefaultClientManager);
        const innerHandle = vi
          .spyOn(handler["inner"] as QueryMetricsHandler, "handle")
          .mockResolvedValue({
            content: [{ type: "text", text: "stub" }],
            isError: false,
          });

        await handler.handle(clientManager, {
          connectorId: "lcc-correct",
          metric: "io.confluent.kafka.connect/sent_records",
          filter: { "resource.connector.id": "lcc-stale" },
        });

        const callArgs = innerHandle.mock.calls[0]![1] as {
          filter: Record<string, string>;
        };
        expect(callArgs.filter["resource.connector.id"]).toBe("lcc-correct");
      });

      it("should forward optional fields like interval, granularity, group_by", async () => {
        const handler = new QueryConnectorMetricsHandler();
        const clientManager = createMockInstance(DefaultClientManager);
        const innerHandle = vi
          .spyOn(handler["inner"] as QueryMetricsHandler, "handle")
          .mockResolvedValue({
            content: [{ type: "text", text: "stub" }],
            isError: false,
          });

        await handler.handle(clientManager, {
          connectorId: "lcc-abc123",
          metric: "io.confluent.kafka.connect/sent_records",
          interval: "2024-01-01T00:00:00Z/2024-01-02T00:00:00Z",
          granularity: "PT5M",
          group_by: ["metric.task_id"],
          aggregation: "AVG",
          limit: 50,
        });

        expect(innerHandle).toHaveBeenCalledWith(
          clientManager,
          expect.objectContaining({
            metric: "io.confluent.kafka.connect/sent_records",
            interval: "2024-01-01T00:00:00Z/2024-01-02T00:00:00Z",
            granularity: "PT5M",
            group_by: ["metric.task_id"],
            aggregation: "AVG",
            limit: 50,
            filter: { "resource.connector.id": "lcc-abc123" },
          }),
        );
      });
    });
  });
});
