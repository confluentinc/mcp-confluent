import {
  analyzeMetrics,
  getStatementMetrics,
  type FlinkStatementMetrics,
} from "@src/confluent/tools/handlers/flink/diagnostics/metrics-helper.js";
import {
  LONG_MIN_SENTINEL,
  getMockedClientManager,
  wireFlinkTelemetry,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("metrics-helper.ts", () => {
  describe("analyzeMetrics()", () => {
    it("should return empty issues and summary placeholder when metrics object is empty", () => {
      const { issues, summary } = analyzeMetrics({});
      expect(issues).toEqual([]);
      expect(summary).toBe("No metrics data available");
    });

    it("should flag high_backpressure when backpressure exceeds 50%", () => {
      const { issues } = analyzeMetrics({ backpressureTimeMsPerSecond: 75 });
      expect(issues).toEqual([
        expect.objectContaining({
          type: "high_backpressure",
          severity: "high",
        }),
      ]);
    });

    it("should flag moderate_backpressure when between 20% and 50%", () => {
      const { issues } = analyzeMetrics({ backpressureTimeMsPerSecond: 30 });
      expect(issues).toEqual([
        expect.objectContaining({
          type: "moderate_backpressure",
          severity: "medium",
        }),
      ]);
    });

    it("should not flag backpressure below the threshold", () => {
      const { issues } = analyzeMetrics({ backpressureTimeMsPerSecond: 10 });
      expect(issues).toEqual([]);
    });

    it("should flag high_lag at medium severity between 100k and 1M pending records", () => {
      const { issues } = analyzeMetrics({ pendingRecords: 500_000 });
      expect(issues).toEqual([
        expect.objectContaining({ type: "high_lag", severity: "medium" }),
      ]);
    });

    it("should escalate high_lag severity above 1M pending records", () => {
      const { issues } = analyzeMetrics({ pendingRecords: 2_000_000 });
      expect(issues).toEqual([
        expect.objectContaining({ type: "high_lag", severity: "high" }),
      ]);
    });

    it.each([
      { value: 500, expected: "low" as const },
      { value: 5_000, expected: "medium" as const },
      { value: 50_000, expected: "high" as const },
    ])(
      "should classify late_data with $value records as $expected severity",
      ({ value, expected }) => {
        const { issues } = analyzeMetrics({ numLateRecordsIn: value });
        expect(issues).toEqual([
          expect.objectContaining({ type: "late_data", severity: expected }),
        ]);
      },
    );

    it("should flag high_lateness when maxInputLatenessMs exceeds 60s", () => {
      const { issues } = analyzeMetrics({ maxInputLatenessMs: 120_000 });
      expect(issues).toEqual([
        expect.objectContaining({ type: "high_lateness", severity: "medium" }),
      ]);
    });

    it("should escalate high_lateness severity above 5 minutes", () => {
      const { issues } = analyzeMetrics({ maxInputLatenessMs: 400_000 });
      expect(issues).toEqual([
        expect.objectContaining({ type: "high_lateness", severity: "high" }),
      ]);
    });

    it("should flag no_input_data when idle >90% and numRecordsIn is 0", () => {
      const { issues } = analyzeMetrics({
        idleTimeMsPerSecond: 95,
        numRecordsIn: 0,
      });
      expect(issues).toEqual([
        expect.objectContaining({ type: "no_input_data", severity: "medium" }),
      ]);
    });

    it("should not flag no_input_data when idle is below threshold", () => {
      const { issues } = analyzeMetrics({
        idleTimeMsPerSecond: 50,
        numRecordsIn: 0,
      });
      expect(issues).toEqual([]);
    });

    it("should flag large_state when state exceeds 10 GB", () => {
      const { issues } = analyzeMetrics({
        stateSizeBytes: 12 * 1024 * 1024 * 1024,
      });
      expect(issues).toEqual([
        expect.objectContaining({ type: "large_state", severity: "medium" }),
      ]);
    });

    it("should compose a summary string from populated fields", () => {
      const metrics: FlinkStatementMetrics = {
        numRecordsIn: 1234,
        numRecordsOut: 567,
        pendingRecords: 0,
        backpressureTimeMsPerSecond: 12.34,
        busyTimeMsPerSecond: 50,
        idleTimeMsPerSecond: 25,
        currentCfus: 3.5,
      };
      const { summary } = analyzeMetrics(metrics);
      expect(summary).toContain("Records in: 1,234");
      expect(summary).toContain("Records out: 567");
      expect(summary).toContain("Backpressure: 12.3%");
      expect(summary).toContain("Busy: 50.0%");
      expect(summary).toContain("Idle: 25.0%");
      expect(summary).toContain("CFUs: 3.50");
    });
  });

  describe("getStatementMetrics()", () => {
    it("should return success with empty metrics when telemetry returns no data", async () => {
      const cm = getMockedClientManager();
      cm.getConfluentCloudTelemetryRestClient().POST.mockResolvedValue({
        data: { data: [] },
      });
      const result = await getStatementMetrics(cm, {
        statementName: "stmt",
        computePoolId: "pool",
      });
      expect(result.success).toBe(true);
      expect(result.metrics).toEqual({});
    });

    it("should populate counter and gauge metrics from telemetry responses and compute watermarkLagMs", async () => {
      const cm = getMockedClientManager();
      wireFlinkTelemetry(cm, {
        // num_records_in (counter, SUM across tasks)
        num_records_in: [
          { value: 100, taskId: "t1" },
          { value: 200, taskId: "t2" },
        ],
        // pending_records
        pending_records: [{ value: 42, taskId: "t1" }],
        // backpressure: 800 ms/s → 80% (max)
        backpressure_time: [{ value: 800, taskId: "t1" }],
        // busy: avg
        "task/busy_time": [{ value: 500, taskId: "t1" }],
        // idle (must include "task" path to land on idleTimeMsPerSecond)
        "task/idle_time": [{ value: 200, taskId: "t1" }],
        // watermarks
        current_input_watermark: [{ value: 10_000, taskId: "t1" }],
        current_output_watermark: [{ value: 9_500, taskId: "t1" }],
      });
      const result = await getStatementMetrics(cm, {
        statementName: "stmt",
        computePoolId: "pool",
      });
      expect(result.success).toBe(true);
      expect(result.metrics).toEqual(
        expect.objectContaining({
          numRecordsIn: 300,
          pendingRecords: 42,
          backpressureTimeMsPerSecond: 80,
          busyTimeMsPerSecond: 50,
          idleTimeMsPerSecond: 20,
          currentInputWatermarkMs: 10_000,
          currentOutputWatermarkMs: 9_500,
          watermarkLagMs: 500,
        }),
      );
    });

    it("should ignore Long.MIN_VALUE watermark sentinels", async () => {
      const cm = getMockedClientManager();
      wireFlinkTelemetry(cm, {
        current_input_watermark: [{ value: LONG_MIN_SENTINEL, taskId: "t1" }],
      });
      const result = await getStatementMetrics(cm, {
        statementName: "stmt",
        computePoolId: "pool",
      });
      expect(result.success).toBe(true);
      expect(result.metrics?.currentInputWatermarkMs).toBeUndefined();
    });

    it("should swallow per-metric errors and continue", async () => {
      const cm = getMockedClientManager();
      const telemetry = cm.getConfluentCloudTelemetryRestClient();
      let calls = 0;
      telemetry.POST.mockImplementation(
        (): Promise<{ data?: unknown; error?: unknown }> => {
          calls++;
          if (calls === 1) return Promise.reject(new Error("network down"));
          return Promise.resolve({ data: { data: [] } });
        },
      );
      const result = await getStatementMetrics(cm, {
        statementName: "stmt",
        computePoolId: "pool",
      });
      expect(result.success).toBe(true);
      // helper queries 13 metrics; first one threw, rest returned empty
      expect(calls).toBeGreaterThan(1);
    });

    it("should return success=false when the telemetry client getter throws", async () => {
      const cm = getMockedClientManager();
      cm.getConfluentCloudTelemetryRestClient.mockImplementation(() => {
        throw new Error("no telemetry config");
      });
      const result = await getStatementMetrics(cm, {
        statementName: "stmt",
        computePoolId: "pool",
      });
      expect(result.success).toBe(false);
      expect(result.error).toContain("no telemetry config");
    });

    it("should query and return per-task breakdown when includeTaskBreakdown is true", async () => {
      const cm = getMockedClientManager();
      // Statement-level queries return empty for non-task/ metric names;
      // task-breakdown queries (io.confluent.flink/task/*) get one point per task.
      wireFlinkTelemetry(cm, {
        "task/": [{ value: 7, taskId: "task-a" }],
      });

      const result = await getStatementMetrics(cm, {
        statementName: "stmt",
        computePoolId: "pool",
        includeTaskBreakdown: true,
      });
      expect(result.success).toBe(true);
      expect(result.metrics?.byTask).toBeDefined();
      expect(result.metrics?.byTask?.[0]).toEqual(
        expect.objectContaining({
          taskId: "task-a",
          numRecordsIn: 7,
          numRecordsOut: 7,
          numBytesIn: 7,
          numBytesOut: 7,
        }),
      );
    });

    it("should skip task entries when taskId or value is missing", async () => {
      const cm = getMockedClientManager();
      wireFlinkTelemetry(cm, {
        "task/": [
          { value: 1 }, // taskId omitted
          { taskId: "task-x" }, // value omitted
        ],
      });
      const result = await getStatementMetrics(cm, {
        statementName: "stmt",
        computePoolId: "pool",
        includeTaskBreakdown: true,
      });
      expect(result.success).toBe(true);
      expect(result.metrics?.byTask).toBeUndefined();
    });

    it("should query and return per-split breakdown when includeSplitBreakdown is true", async () => {
      const cm = getMockedClientManager();
      wireFlinkTelemetry(cm, {
        "split/": [{ value: 12_345, splitName: "orders-0" }],
      });
      const result = await getStatementMetrics(cm, {
        statementName: "stmt",
        computePoolId: "pool",
        includeSplitBreakdown: true,
      });
      expect(result.success).toBe(true);
      expect(result.metrics?.bySplit?.[0]).toEqual(
        expect.objectContaining({
          splitName: "orders-0",
          currentWatermarkMs: 12_345,
        }),
      );
    });

    it("should skip per-split watermark_ms points equal to Long.MIN_VALUE", async () => {
      const cm = getMockedClientManager();
      const telemetry = cm.getConfluentCloudTelemetryRestClient();
      telemetry.POST.mockImplementation(
        (
          _path: unknown,
          opts: unknown,
        ): Promise<{ data?: unknown; error?: unknown }> => {
          const o = opts as {
            body?: { aggregations?: Array<{ metric?: string }> };
          };
          const metric = o.body?.aggregations?.[0]?.metric ?? "";
          if (metric === "io.confluent.flink/split/current_watermark_ms") {
            return Promise.resolve({
              data: {
                data: [
                  {
                    "metric.flink_split": "orders-0",
                    points: [{ value: LONG_MIN_SENTINEL, timestamp: "t" }],
                  },
                ],
              },
            });
          }
          return Promise.resolve({ data: { data: [] } });
        },
      );
      const result = await getStatementMetrics(cm, {
        statementName: "stmt",
        computePoolId: "pool",
        includeSplitBreakdown: true,
      });
      expect(result.success).toBe(true);
      expect(result.metrics?.bySplit).toBeUndefined();
    });

    it("should swallow per-metric errors during task breakdown", async () => {
      const cm = getMockedClientManager();
      let calls = 0;
      cm.getConfluentCloudTelemetryRestClient().POST.mockImplementation(
        (): Promise<{ data?: unknown; error?: unknown }> => {
          calls++;
          // First call (statement-level loop) returns empty; rest throw to
          // exercise the catch inside queryTaskMetrics/querySplitMetrics.
          if (calls === 1) return Promise.resolve({ data: { data: [] } });
          return Promise.reject(new Error("transient"));
        },
      );
      const result = await getStatementMetrics(cm, {
        statementName: "stmt",
        computePoolId: "pool",
        includeTaskBreakdown: true,
        includeSplitBreakdown: true,
      });
      expect(result.success).toBe(true);
      expect(result.metrics?.byTask).toBeUndefined();
      expect(result.metrics?.bySplit).toBeUndefined();
    });
  });
});
