import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { QueryProfilerHandler } from "@src/confluent/tools/handlers/flink/diagnostics/query-profiler-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  DEFAULT_CONNECTION_ID,
  FLINK_TELEMETRY_CONN,
  FlinkGetCase,
  runtimeWith,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  wireFlinkTelemetry,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const STATEMENT_NAME = "my-statement";

const TASK_GRAPH = {
  tasks: [
    {
      task_id: "task-1",
      task_name: "Source: orders",
      input_tasks: [],
      included_operators: [
        { num: 0, operator_id: "op-1", operator_name: "Source" },
      ],
    },
  ],
};

describe("query-profiler-handler.ts", () => {
  describe("QueryProfilerHandler", () => {
    const handler = new QueryProfilerHandler();

    describe("getToolConfig()", () => {
      it("should describe the get-flink-statement-profile tool as read-only", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.GET_FLINK_STATEMENT_PROFILE);
        expect(config.description).toContain("Query Profiler");
        expect(config.inputSchema).toHaveProperty("statementName");
        expect(config.inputSchema).toHaveProperty("intervalMinutes");
        expect(config.inputSchema).toHaveProperty("includeAnalysis");
        expect(config.annotations).toBe(READ_ONLY);
      });
    });

    describe("handle()", () => {
      const cases: FlinkGetCase[] = [
        {
          label: "throws ZodError when statementName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label: "uses org/env/compute IDs from config when args absent",
          args: { statementName: STATEMENT_NAME },
          flinkGetData: { Graph: '{"tasks":[]}' },
          outcome: { resolves: `Query Profiler for '${STATEMENT_NAME}'` },
        },
        {
          label: "uses explicit org/env/compute args over config",
          args: {
            statementName: STATEMENT_NAME,
            organizationId: "org-from-args",
            environmentId: "env-from-args",
            computePoolId: "lfcp-from-args",
          },
          flinkGetData: { Graph: '{"tasks":[]}' },
          outcome: { resolves: `Query Profiler for '${STATEMENT_NAME}'` },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({
          args,
          outcome,
          flinkGetData,
          connectionConfig = FLINK_TELEMETRY_CONN,
        }) => {
          const clientManager = getMockedClientManager();
          if (flinkGetData !== undefined) {
            clientManager
              .getConfluentCloudFlinkRestClient()
              .GET.mockResolvedValue({ data: flinkGetData });
            clientManager
              .getConfluentCloudTelemetryRestClient()
              .POST.mockResolvedValue({ data: { data: [] } });
          }
          await assertHandleCase({
            handler,
            runtime: runtimeWithDecoy(
              connectionConfig,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientManager,
          });
        },
      );

      it("should return an error response when the task-graph GET errors", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudFlinkRestClient()
          .GET.mockResolvedValueOnce({ error: { code: 500 } });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            FLINK_TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: "Failed to get task graph", isError: true },
          clientManager,
        });
      });

      it("should return an error response when Graph field is missing", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudFlinkRestClient()
          .GET.mockResolvedValue({ data: {} });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            FLINK_TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: "Task graph not available", isError: true },
          clientManager,
        });
      });

      it("should return an error response when Graph JSON is malformed", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudFlinkRestClient()
          .GET.mockResolvedValue({ data: { Graph: "{not json" } });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            FLINK_TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: "Failed to parse task graph", isError: true },
          clientManager,
        });
      });

      it("should return an error response when Graph parses but has no tasks array", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudFlinkRestClient()
          .GET.mockResolvedValue({ data: { Graph: '{"unexpected":true}' } });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            FLINK_TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: {
            resolves: "Task graph payload is missing its tasks array",
            isError: true,
          },
          clientManager,
        });
      });

      it("should detect high backpressure per-task when backpressurePercent exceeds 50%", async () => {
        const cm = getMockedClientManager();
        cm.getConfluentCloudFlinkRestClient().GET.mockResolvedValue({
          data: { Graph: JSON.stringify(TASK_GRAPH) },
        });
        // task/backpressure_time at 600 ms/s → 60% → medium severity
        wireFlinkTelemetry(cm, {
          "task/backpressure_time": [{ value: 600, taskId: "task-1" }],
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            FLINK_TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            cm,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: "high_backpressure" },
          clientManager: cm,
        });
      });

      it("should escalate severity when backpressurePercent exceeds 80%", async () => {
        const cm = getMockedClientManager();
        cm.getConfluentCloudFlinkRestClient().GET.mockResolvedValue({
          data: { Graph: JSON.stringify(TASK_GRAPH) },
        });
        // 900 ms/s → 90% → "high"
        wireFlinkTelemetry(cm, {
          "task/backpressure_time": [{ value: 900, taskId: "task-1" }],
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            FLINK_TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            cm,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: '"severity": "high"' },
          clientManager: cm,
        });
      });

      it("should format busyPercent and idlePercent as percentages when telemetry reports them", async () => {
        const cm = getMockedClientManager();
        cm.getConfluentCloudFlinkRestClient().GET.mockResolvedValue({
          data: { Graph: JSON.stringify(TASK_GRAPH) },
        });
        // task/busy_time_ms_per_second at 456 ms/s → 45.6%;
        // task/idle_time_ms_per_second at 123 ms/s → 12.3%
        wireFlinkTelemetry(cm, {
          "task/busy_time": [{ value: 456, taskId: "task-1" }],
          "task/idle_time": [{ value: 123, taskId: "task-1" }],
        });
        const result = await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            FLINK_TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            cm,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: '"busyPercent": "45.6%"' },
          clientManager: cm,
        });
        const text = result?.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        expect(text).toContain('"idlePercent": "12.3%"');
      });

      it("should detect high consumer lag from summary pendingRecords", async () => {
        const cm = getMockedClientManager();
        cm.getConfluentCloudFlinkRestClient().GET.mockResolvedValue({
          data: { Graph: JSON.stringify(TASK_GRAPH) },
        });
        // pending_records is a summary (statement-level) metric; the helper
        // POSTs it without a group_by task id.
        wireFlinkTelemetry(cm, {
          pending_records: [{ value: 2_000_000 }],
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            FLINK_TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            cm,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: "high_consumer_lag" },
          clientManager: cm,
        });
      });

      it("should detect late_data when summary numLateRecordsIn > 0", async () => {
        const cm = getMockedClientManager();
        cm.getConfluentCloudFlinkRestClient().GET.mockResolvedValue({
          data: { Graph: JSON.stringify(TASK_GRAPH) },
        });
        wireFlinkTelemetry(cm, {
          num_late_records_in: [{ value: 50_000 }],
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            FLINK_TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            cm,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: "late_data" },
          clientManager: cm,
        });
      });

      it("should detect large_state when stateBytes exceeds 10 GB", async () => {
        const cm = getMockedClientManager();
        cm.getConfluentCloudFlinkRestClient().GET.mockResolvedValue({
          data: { Graph: JSON.stringify(TASK_GRAPH) },
        });
        // 11 GB in bytes
        wireFlinkTelemetry(cm, {
          state_size_bytes: [{ value: 11 * 1024 * 1024 * 1024 }],
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            FLINK_TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            cm,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: "large_state" },
          clientManager: cm,
        });
      });

      it("should skip analysis section when includeAnalysis is false", async () => {
        const cm = getMockedClientManager();
        cm.getConfluentCloudFlinkRestClient().GET.mockResolvedValue({
          data: { Graph: JSON.stringify(TASK_GRAPH) },
        });
        cm.getConfluentCloudTelemetryRestClient().POST.mockResolvedValue({
          data: { data: [] },
        });
        const result = await handler.handle(
          runtimeWith(FLINK_TELEMETRY_CONN, DEFAULT_CONNECTION_ID, cm),
          { statementName: STATEMENT_NAME, includeAnalysis: false },
        );
        const text = result.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        expect(text).not.toContain("detectedIssues");
        expect(text).not.toContain("issueCount");
      });

      it('should render stateSizeMB as "0.00" when summary stateBytes is 0', async () => {
        const cm = getMockedClientManager();
        cm.getConfluentCloudFlinkRestClient().GET.mockResolvedValue({
          data: { Graph: '{"tasks":[]}' },
        });
        // A statement with no keyed state legitimately reports 0 bytes; the
        // rendered summary must keep it, not drop it as if the metric were
        // absent.
        wireFlinkTelemetry(cm, {
          "operator/state_size_bytes": [{ value: 0 }],
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            FLINK_TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            cm,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: '"stateSizeMB": "0.00"' },
          clientManager: cm,
        });
      });

      it("should render a watermark of 0 as the Unix epoch, not drop it", async () => {
        const cm = getMockedClientManager();
        cm.getConfluentCloudFlinkRestClient().GET.mockResolvedValue({
          data: { Graph: '{"tasks":[]}' },
        });
        // 0 is a real epoch-ms watermark (1970-01-01); only the Long.MIN_VALUE
        // sentinel means "no watermark", so 0 must render.
        wireFlinkTelemetry(cm, {
          current_input_watermark_milliseconds: [{ value: 0 }],
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            FLINK_TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            cm,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: '"inputWatermark": "1970-01-01T00:00:00.000Z"' },
          clientManager: cm,
        });
      });
    });
  });
});
