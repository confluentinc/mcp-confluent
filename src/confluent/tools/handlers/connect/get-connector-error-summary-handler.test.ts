import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { GetConnectorErrorSummaryHandler } from "@src/confluent/tools/handlers/connect/get-connector-error-summary-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS } from "@src/env-schema.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it, type Mocked, vi } from "vitest";

describe("get-connector-error-summary-handler.ts", () => {
  describe("GetConnectorErrorSummaryHandler", () => {
    const handler = new GetConnectorErrorSummaryHandler();
    let clientManager: Mocked<DefaultClientManager>;
    let restGet: ReturnType<typeof vi.fn>;

    const baseArgs = {
      environmentId: "env-1",
      clusterId: "lkc-1",
      connectorName: "cypher-source",
    };

    beforeEach(() => {
      restGet = vi.fn();
      clientManager = createMockInstance(DefaultClientManager);
      clientManager.getConfluentCloudRestClient.mockReturnValue({
        GET: restGet,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });

    describe("getToolConfig()", () => {
      it("should return GET_CONNECTOR_ERROR_SUMMARY with READ_ONLY annotations", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.GET_CONNECTOR_ERROR_SUMMARY);
        expect(config.annotations).toBe(READ_ONLY);
      });
    });

    describe("getRequiredEnvVars()", () => {
      it("should return CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS", () => {
        expect(handler.getRequiredEnvVars()).toBe(
          CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS,
        );
      });
    });

    describe("isConfluentCloudOnly()", () => {
      it("should return true", () => {
        expect(handler.isConfluentCloudOnly()).toBe(true);
      });
    });

    describe("handle()", () => {
      it("should return a one-liner when the connector is healthy", async () => {
        restGet.mockResolvedValue({
          data: {
            name: "cypher-source",
            connector: { state: "RUNNING", worker_id: "w1", trace: "" },
            tasks: [{ id: 0, state: "RUNNING", worker_id: "w1" }],
            type: "source",
          },
          error: undefined,
        });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBeFalsy();
        const text = (result.content[0] as { text: string }).text;
        expect(text).toBe(
          "Connector cypher-source is RUNNING. No errors to summarize.",
        );
      });

      it("should project the cypher-source FAILED fixture into a structured summary", async () => {
        const validationErrors = [
          'database.hostname: Error while validating connector config: FATAL: password authentication failed for user "postgres"',
          'database.port: Error while validating connector config: FATAL: password authentication failed for user "postgres"',
          'database.user: Error while validating connector config: FATAL: password authentication failed for user "postgres"',
          'database.password: Error while validating connector config: FATAL: password authentication failed for user "postgres"',
          'database.dbname: Error while validating connector config: FATAL: password authentication failed for user "postgres"',
        ];
        restGet.mockResolvedValue({
          data: {
            name: "cypher-source",
            connector: {
              state: "FAILED",
              worker_id: "cypher-source",
              trace:
                "Unable to validate configuration. ...\n(line 2)\n(line 3)",
            },
            tasks: [
              {
                id: 0,
                state: "USER_ACTIONABLE_ERROR",
                worker_id: "cypher-source",
                msg: "",
              },
            ],
            type: "source",
            errors_from_trace: [],
            validation_errors: validationErrors,
            override_message: "",
            validation_error_category_info: null,
            is_csfle_error: false,
            error_details: null,
            error_summary:
              'The Kafka connector on Confluent Cloud failed due to an authentication issue when attempting to connect to the PostgreSQL database. The root cause is a "password authentication failed" error for the user "postgres,"...',
            error_recommendation_enabled: true,
            plugin_lifecycle: "ACTIVE",
          },
          error: undefined,
        });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBeFalsy();
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Error summary for cypher-source");

        const jsonStart = text.indexOf("{");
        const projection = JSON.parse(text.slice(jsonStart));
        expect(projection.connectorName).toBe("cypher-source");
        expect(projection.state).toBe("FAILED");
        expect(projection.hasError).toBe(true);
        expect(projection.totalTasks).toBe(1);
        expect(projection.summary).toContain("authentication");
        expect(projection.pluginLifecycle).toBe("ACTIVE");
        expect(projection.validationErrors).toHaveLength(5);
        // First-colon split must preserve "FATAL: ..." in the message portion.
        expect(projection.validationErrors[0]).toEqual({
          field: "database.hostname",
          message:
            'Error while validating connector config: FATAL: password authentication failed for user "postgres"',
        });
        expect(projection.failedTasks).toHaveLength(1);
        expect(projection.failedTasks[0]).toMatchObject({
          id: 0,
          state: "USER_ACTIONABLE_ERROR",
          workerId: "cypher-source",
        });
        // Empty msg, empty errors_from_trace, null error_details, false is_csfle_error
        // should be dropped from the projection.
        expect(projection.failedTasks[0].msg).toBeUndefined();
        expect(projection).not.toHaveProperty("errorsFromTrace");
        expect(projection).not.toHaveProperty("errorDetails");
        expect(projection).not.toHaveProperty("isCsfleError");
        expect(projection.connectorTraceHead).toContain(
          "Unable to validate configuration",
        );
      });

      it("should prefer override_message over error_summary", async () => {
        restGet.mockResolvedValue({
          data: {
            name: "cypher-source",
            connector: { state: "FAILED", worker_id: "w1", trace: "" },
            tasks: [],
            override_message: "Operator override: contact support.",
            error_summary: "Auto-generated summary",
            validation_errors: [],
          },
          error: undefined,
        });

        const result = await handler.handle(clientManager, baseArgs);
        const text = (result.content[0] as { text: string }).text;
        const projection = JSON.parse(text.slice(text.indexOf("{")));
        expect(projection.summary).toBe("Operator override: contact support.");
      });

      it("should fall back to trace heads when no Cloud diagnostic extras are present", async () => {
        const longTrace = Array.from({ length: 30 }, (_, i) => `line${i}`).join(
          "\n",
        );
        restGet.mockResolvedValue({
          data: {
            name: "oss-connector",
            connector: {
              state: "FAILED",
              worker_id: "w1",
              trace: longTrace,
            },
            tasks: [
              {
                id: 0,
                state: "FAILED",
                worker_id: "w1",
                trace: longTrace,
                msg: "task failure",
              },
            ],
          },
          error: undefined,
        });

        const result = await handler.handle(clientManager, {
          ...baseArgs,
          connectorName: "oss-connector",
        });
        const text = (result.content[0] as { text: string }).text;
        const projection = JSON.parse(text.slice(text.indexOf("{")));
        expect(projection.summary).toBeUndefined();
        expect(projection.connectorTraceHead).toContain("line0");
        expect(projection.connectorTraceHead).toContain("[truncated]");
        expect(projection.failedTasks[0].traceHead).toContain("[truncated]");
        expect(projection.failedTasks[0].msg).toBe("task failure");
      });

      it("should truncate very long single-line traces by character limit", async () => {
        const longLine = "x".repeat(2000);
        restGet.mockResolvedValue({
          data: {
            name: "noisy",
            connector: { state: "FAILED", worker_id: "w1", trace: longLine },
            tasks: [],
          },
          error: undefined,
        });

        const result = await handler.handle(clientManager, {
          ...baseArgs,
          connectorName: "noisy",
        });
        const text = (result.content[0] as { text: string }).text;
        const projection = JSON.parse(text.slice(text.indexOf("{")));
        expect(projection.connectorTraceHead).toMatch(/\[truncated\]$/);
        expect(projection.connectorTraceHead.length).toBeLessThan(
          longLine.length,
        );
      });

      it("should return an error response when the REST call fails", async () => {
        const error = { error_code: 404, message: "missing" };
        restGet.mockResolvedValue({ data: undefined, error });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Failed to get error summary");
        expect(text).toContain(JSON.stringify(error));
      });
    });
  });
});
