import { QueryMetricsHandler } from "@src/confluent/tools/handlers/metrics/query-metrics-handler.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  telemetryRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("query-metrics-handler.ts", () => {
  describe("QueryMetricsHandler", () => {
    const handler = new QueryMetricsHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with a telemetry block", () => {
        expect(handler.enabledConnectionIds(telemetryRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a telemetry block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });
    });
  });
});
