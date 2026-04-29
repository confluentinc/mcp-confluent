import { ListMetricsHandler } from "@src/confluent/tools/handlers/metrics/list-metrics-handler.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  telemetryRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("list-metrics-handler.ts", () => {
  describe("ListMetricsHandler", () => {
    const handler = new ListMetricsHandler();

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
