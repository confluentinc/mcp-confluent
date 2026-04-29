import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { ListConnectorMetricsHandler } from "@src/confluent/tools/handlers/connect/list-connector-metrics-handler.js";
import { ListMetricsHandler } from "@src/confluent/tools/handlers/metrics/list-metrics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { TELEMETRY_REQUIRED_ENV_VARS } from "@src/env-schema.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";

describe("list-connector-metrics-handler.ts", () => {
  describe("ListConnectorMetricsHandler", () => {
    describe("getToolConfig()", () => {
      it("should return LIST_CONNECTOR_METRICS with READ_ONLY annotations", () => {
        const handler = new ListConnectorMetricsHandler();
        const config = handler.getToolConfig();

        expect(config.name).toBe(ToolName.LIST_CONNECTOR_METRICS);
        expect(config.annotations).toBe(READ_ONLY);
        expect(config.description).toContain("connector");
      });
    });

    describe("getRequiredEnvVars()", () => {
      it("should return TELEMETRY_REQUIRED_ENV_VARS", () => {
        const handler = new ListConnectorMetricsHandler();

        expect(handler.getRequiredEnvVars()).toBe(TELEMETRY_REQUIRED_ENV_VARS);
      });
    });

    describe("isConfluentCloudOnly()", () => {
      it("should return true", () => {
        const handler = new ListConnectorMetricsHandler();

        expect(handler.isConfluentCloudOnly()).toBe(true);
      });
    });

    describe("handle()", () => {
      it("should delegate to ListMetricsHandler with resource_type connector", async () => {
        const handler = new ListConnectorMetricsHandler();
        const clientManager = createMockInstance(DefaultClientManager);
        const innerHandle = vi
          .spyOn(handler["inner"] as ListMetricsHandler, "handle")
          .mockResolvedValue({
            content: [{ type: "text", text: "stub" }],
            isError: false,
          });

        const result = await handler.handle(clientManager, {});

        expect(innerHandle).toHaveBeenCalledOnce();
        expect(innerHandle).toHaveBeenCalledWith(clientManager, {
          resource_type: "connector",
        });
        expect(result).toEqual({
          content: [{ type: "text", text: "stub" }],
          isError: false,
        });
      });

      it("should pass resource_type connector regardless of provided arguments", async () => {
        const handler = new ListConnectorMetricsHandler();
        const clientManager = createMockInstance(DefaultClientManager);
        const innerHandle = vi
          .spyOn(handler["inner"] as ListMetricsHandler, "handle")
          .mockResolvedValue({
            content: [{ type: "text", text: "stub" }],
            isError: false,
          });

        await handler.handle(clientManager, { resource_type: "kafka" });

        expect(innerHandle).toHaveBeenCalledWith(clientManager, {
          resource_type: "connector",
        });
      });
    });
  });
});
