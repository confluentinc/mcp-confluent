import type { MockedClientManager } from "./clients.js";

export type FlinkTelemetryPoint = {
  value: number;
  taskId?: string;
  splitName?: string;
};

/** Approximate Long.MIN_VALUE watermark sentinel, matching the production
 *  Flink diagnostics code's comparison sentinel for "no watermark yet" on
 *  both per-task and per-split metrics. This is intentionally not the
 *  exact Java Long.MIN_VALUE literal — the value exceeds JS's safe-integer
 *  range, so it's the same approximate double the production code compares
 *  against. */
export const LONG_MIN_SENTINEL = -9_223_372_036_854_776_000;

/** Configure the Flink telemetry POST mock to respond per metric-name
 *  substring. The first key whose substring appears in the requested
 *  metric name wins; unmatched metrics resolve to an empty data array
 *  so callers don't have to enumerate every Flink metric they ignore.
 *  Each array element yields one point (taskId/splitName labels
 *  preserved), modelling the Confluent Cloud telemetry response shape. */
export function wireFlinkTelemetry(
  cm: MockedClientManager,
  byMetric: Record<string, FlinkTelemetryPoint[]>,
): void {
  cm.getConfluentCloudTelemetryRestClient().POST.mockImplementation(
    (
      _path: unknown,
      opts: unknown,
    ): Promise<{ data?: unknown; error?: unknown }> => {
      const o = opts as {
        body?: { aggregations?: Array<{ metric?: string }> };
      };
      const metric = o.body?.aggregations?.[0]?.metric ?? "";
      for (const [substr, points] of Object.entries(byMetric)) {
        if (metric.includes(substr)) {
          return Promise.resolve({
            data: {
              data: points.map((p) => ({
                "metric.flink_task.id": p.taskId,
                "metric.flink_split": p.splitName,
                points: [{ value: p.value, timestamp: "t" }],
              })),
            },
          });
        }
      }
      return Promise.resolve({ data: { data: [] } });
    },
  );
}
