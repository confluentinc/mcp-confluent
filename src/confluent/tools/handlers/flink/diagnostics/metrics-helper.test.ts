import type { BaseClientManager } from "@src/confluent/base-client-manager.js";
import {
  analyzeMetrics,
  getStatementMetrics,
  type FlinkStatementMetrics,
} from "@src/confluent/tools/handlers/flink/diagnostics/metrics-helper.js";
import { getMockedClientManager } from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const STATEMENT_NAME = "my-statement";
const COMPUTE_POOL_ID = "lfcp-1";

// One mock response shape that satisfies the three POST loops in
// metrics-helper.ts. The aggregated-metrics loop ignores the group keys;
// the task-breakdown loop reads `metric.flink_task.id`; the split-breakdown
// loop reads `metric.flink_split`. Providing both keys plus a `points` array
// with a positive value > LONG_MIN_VALUE+1000000 keeps every branch happy.
function universalGroupedResponse(value: number) {
  return {
    data: {
      data: [
        {
          "metric.flink_task.id": "task-A",
          "metric.flink_split": "topic-0",
          points: [{ value, timestamp: "2024-01-01T00:00:00Z" }],
        },
      ],
    },
  };
}

describe("metrics-helper.ts", () => {
  describe("analyzeMetrics()", () => {
    it("should return 'No metrics data available' for an empty metrics object", () => {
      const result = analyzeMetrics({});
      expect(result.issues).toEqual([]);
      expect(result.summary).toBe("No metrics data available");
    });

    it("should produce summary parts for every supplied counter, including Idle and CFUs", () => {
      const metrics: FlinkStatementMetrics = {
        numRecordsIn: 1234,
        numRecordsOut: 5678,
        pendingRecords: 42,
        backpressureTimeMsPerSecond: 10,
        busyTimeMsPerSecond: 30,
        idleTimeMsPerSecond: 60,
        currentCfus: 1.5,
      };
      const result = analyzeMetrics(metrics);
      expect(result.summary).toBe(
        "Records in: 1,234 | Records out: 5,678 | Pending: 42 | Backpressure: 10.0% | Busy: 30.0% | Idle: 60.0% | CFUs: 1.50",
      );
    });

    it("should emit high_backpressure issue when backpressure > 50%", () => {
      const result = analyzeMetrics({ backpressureTimeMsPerSecond: 75 });
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        type: "high_backpressure",
        severity: "high",
        value: 75,
      });
    });

    it("should emit moderate_backpressure issue when 20% < backpressure <= 50%", () => {
      const result = analyzeMetrics({ backpressureTimeMsPerSecond: 30 });
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        type: "moderate_backpressure",
        severity: "medium",
        value: 30,
      });
    });

    it("should emit high_lag issue with medium severity for pendingRecords > 100000", () => {
      const result = analyzeMetrics({ pendingRecords: 500_000 });
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        type: "high_lag",
        severity: "medium",
      });
    });

    it("should emit high_lag with high severity for pendingRecords > 1,000,000", () => {
      const result = analyzeMetrics({ pendingRecords: 2_000_000 });
      expect(result.issues[0]).toMatchObject({
        type: "high_lag",
        severity: "high",
      });
    });

    it.each([
      { value: 500, severity: "low" as const },
      { value: 5000, severity: "medium" as const },
      { value: 50_000, severity: "high" as const },
    ])(
      "should emit late_data issue with $severity severity for numLateRecordsIn=$value",
      ({ value, severity }) => {
        const result = analyzeMetrics({ numLateRecordsIn: value });
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]).toMatchObject({
          type: "late_data",
          severity,
        });
      },
    );

    it.each([
      { value: 120_000, severity: "medium" as const },
      { value: 600_000, severity: "high" as const },
    ])(
      "should emit high_lateness issue with $severity severity for maxInputLatenessMs=$value",
      ({ value, severity }) => {
        const result = analyzeMetrics({ maxInputLatenessMs: value });
        expect(result.issues).toHaveLength(1);
        expect(result.issues[0]).toMatchObject({
          type: "high_lateness",
          severity,
        });
      },
    );

    it("should emit no_input_data issue when idle > 90% and numRecordsIn === 0", () => {
      const result = analyzeMetrics({
        idleTimeMsPerSecond: 95,
        numRecordsIn: 0,
      });
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        type: "no_input_data",
        severity: "medium",
      });
    });

    it("should not emit no_input_data when idle is high but records are flowing", () => {
      const result = analyzeMetrics({
        idleTimeMsPerSecond: 95,
        numRecordsIn: 100,
      });
      expect(result.issues).toEqual([]);
    });

    it("should emit large_state issue when state size > 10 GB", () => {
      const result = analyzeMetrics({
        stateSizeBytes: 12 * 1024 * 1024 * 1024,
      });
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        type: "large_state",
        severity: "medium",
      });
    });

    it("should not emit large_state for state size under 10 GB", () => {
      const result = analyzeMetrics({ stateSizeBytes: 5 * 1024 * 1024 * 1024 });
      expect(result.issues).toEqual([]);
    });
  });

  describe("getStatementMetrics()", () => {
    let clientManager: ReturnType<typeof getMockedClientManager>;

    beforeEach(() => {
      clientManager = getMockedClientManager();
    });

    it("should aggregate metrics across the 13 telemetry calls and return success", async () => {
      const telemetry = clientManager.getConfluentCloudTelemetryRestClient();
      telemetry.POST.mockResolvedValue(universalGroupedResponse(500));

      const result = await getStatementMetrics(
        clientManager as unknown as BaseClientManager,
        { statementName: STATEMENT_NAME, computePoolId: COMPUTE_POOL_ID },
      );

      expect(result.success).toBe(true);
      expect(result.metrics).toBeDefined();
      // 13 metrics queried by getStatementMetrics when neither breakdown is requested.
      expect(telemetry.POST).toHaveBeenCalledTimes(13);
      // Sum-aggregated counter (single data item, value 500)
      expect(result.metrics?.numRecordsIn).toBe(500);
      expect(result.metrics?.numRecordsOut).toBe(500);
      // Backpressure: max/1000*100 = 50
      expect(result.metrics?.backpressureTimeMsPerSecond).toBe(50);
      // Busy: avg/1000*100 = 50
      expect(result.metrics?.busyTimeMsPerSecond).toBe(50);
      // watermarkLagMs derived from input - output watermark
      expect(result.metrics?.watermarkLagMs).toBe(0);
    });

    it("should pass the supplied statementName and computePoolId to the telemetry filter", async () => {
      const telemetry = clientManager.getConfluentCloudTelemetryRestClient();
      telemetry.POST.mockResolvedValue({ data: { data: [] } });

      await getStatementMetrics(clientManager as unknown as BaseClientManager, {
        statementName: STATEMENT_NAME,
        computePoolId: COMPUTE_POOL_ID,
      });

      expect(telemetry.POST).toHaveBeenCalledWith(
        "/v2/metrics/{dataset}/query",
        expect.objectContaining({
          body: expect.objectContaining({
            filter: expect.objectContaining({
              filters: [
                {
                  field: "resource.flink_statement.name",
                  op: "EQ",
                  value: STATEMENT_NAME,
                },
                {
                  field: "resource.compute_pool.id",
                  op: "EQ",
                  value: COMPUTE_POOL_ID,
                },
              ],
            }),
          }),
        }),
      );
    });

    it("should swallow per-metric POST errors and still return success", async () => {
      const telemetry = clientManager.getConfluentCloudTelemetryRestClient();
      telemetry.POST.mockRejectedValue(new Error("boom"));

      const result = await getStatementMetrics(
        clientManager as unknown as BaseClientManager,
        { statementName: STATEMENT_NAME, computePoolId: COMPUTE_POOL_ID },
      );

      expect(result.success).toBe(true);
      expect(result.metrics).toEqual({});
    });

    it("should skip data points below LONG_MIN_VALUE+1000000 sentinel", async () => {
      const telemetry = clientManager.getConfluentCloudTelemetryRestClient();
      telemetry.POST.mockResolvedValue({
        data: {
          data: [
            {
              "metric.flink_task.id": "task-A",
              points: [{ value: -9223372036854776000 }],
            },
          ],
        },
      });

      const result = await getStatementMetrics(
        clientManager as unknown as BaseClientManager,
        { statementName: STATEMENT_NAME, computePoolId: COMPUTE_POOL_ID },
      );

      expect(result.success).toBe(true);
      expect(result.metrics?.numRecordsIn).toBeUndefined();
      expect(result.metrics?.currentInputWatermarkMs).toBeUndefined();
    });

    it("should query per-task breakdown when includeTaskBreakdown is true", async () => {
      const telemetry = clientManager.getConfluentCloudTelemetryRestClient();
      telemetry.POST.mockResolvedValue(universalGroupedResponse(1234));

      const result = await getStatementMetrics(
        clientManager as unknown as BaseClientManager,
        {
          statementName: STATEMENT_NAME,
          computePoolId: COMPUTE_POOL_ID,
          includeTaskBreakdown: true,
        },
      );

      expect(result.success).toBe(true);
      // 13 main + 8 task = 21 POSTs
      expect(telemetry.POST).toHaveBeenCalledTimes(21);
      expect(result.metrics?.byTask).toEqual([
        {
          taskId: "task-A",
          numRecordsIn: 1234,
          numRecordsOut: 1234,
          numBytesIn: 1234,
          numBytesOut: 1234,
          backpressureTimeMsPerSecond: 1234,
          busyTimeMsPerSecond: 1234,
          idleTimeMsPerSecond: 1234,
          stateSizeBytes: 1234,
        },
      ]);
    });

    it("should not include byTask when task breakdown returns no rows", async () => {
      const telemetry = clientManager.getConfluentCloudTelemetryRestClient();
      telemetry.POST.mockResolvedValue({ data: { data: [] } });

      const result = await getStatementMetrics(
        clientManager as unknown as BaseClientManager,
        {
          statementName: STATEMENT_NAME,
          computePoolId: COMPUTE_POOL_ID,
          includeTaskBreakdown: true,
        },
      );

      expect(result.success).toBe(true);
      expect(result.metrics?.byTask).toBeUndefined();
    });

    it("should query per-split breakdown when includeSplitBreakdown is true", async () => {
      const telemetry = clientManager.getConfluentCloudTelemetryRestClient();
      telemetry.POST.mockResolvedValue(universalGroupedResponse(5000));

      const result = await getStatementMetrics(
        clientManager as unknown as BaseClientManager,
        {
          statementName: STATEMENT_NAME,
          computePoolId: COMPUTE_POOL_ID,
          includeSplitBreakdown: true,
        },
      );

      expect(result.success).toBe(true);
      // 13 main + 4 split = 17 POSTs
      expect(telemetry.POST).toHaveBeenCalledTimes(17);
      expect(result.metrics?.bySplit).toEqual([
        {
          splitName: "topic-0",
          currentWatermarkMs: 5000,
          watermarkActiveTimeMsPerSecond: 5000,
          watermarkPausedTimeMsPerSecond: 5000,
          watermarkIdleTimeMsPerSecond: 5000,
        },
      ]);
    });

    it("should skip split watermark_ms sentinel value but still record other split metrics", async () => {
      const telemetry = clientManager.getConfluentCloudTelemetryRestClient();
      telemetry.POST.mockResolvedValue({
        data: {
          data: [
            {
              "metric.flink_split": "topic-0",
              points: [{ value: -9223372036854776000 }],
            },
          ],
        },
      });

      const result = await getStatementMetrics(
        clientManager as unknown as BaseClientManager,
        {
          statementName: STATEMENT_NAME,
          computePoolId: COMPUTE_POOL_ID,
          includeSplitBreakdown: true,
        },
      );

      expect(result.success).toBe(true);
      // The watermark_ms metric (first in querySplitMetrics) skips sentinel
      // values, so currentWatermarkMs is unset. The three watermark-time
      // metrics don't apply the sentinel check, so they still populate.
      expect(result.metrics?.bySplit).toEqual([
        {
          splitName: "topic-0",
          watermarkActiveTimeMsPerSecond: -9223372036854776000,
          watermarkPausedTimeMsPerSecond: -9223372036854776000,
          watermarkIdleTimeMsPerSecond: -9223372036854776000,
        },
      ]);
    });

    it("should swallow split breakdown POST errors", async () => {
      const telemetry = clientManager.getConfluentCloudTelemetryRestClient();
      telemetry.POST
        // 13 main queries: empty
        .mockResolvedValue({ data: { data: [] } });
      // After main queries, all subsequent calls (split) reject
      telemetry.POST.mockImplementation(async () => {
        throw new Error("split boom");
      });

      const result = await getStatementMetrics(
        clientManager as unknown as BaseClientManager,
        {
          statementName: STATEMENT_NAME,
          computePoolId: COMPUTE_POOL_ID,
          includeSplitBreakdown: true,
        },
      );

      expect(result.success).toBe(true);
      expect(result.metrics?.bySplit).toBeUndefined();
    });
  });
});
