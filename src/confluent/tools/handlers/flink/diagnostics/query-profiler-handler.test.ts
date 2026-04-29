import { QueryProfilerHandler } from "@src/confluent/tools/handlers/flink/diagnostics/query-profiler-handler.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  flinkRuntime,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("query-profiler-handler.ts", () => {
  describe("QueryProfilerHandler", () => {
    const handler = new QueryProfilerHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with both flink and telemetry blocks", () => {
        const runtime = runtimeWith({
          flink: {
            endpoint: "https://flink.us-east-1.aws.confluent.cloud",
            auth: { type: "api_key", key: "k", secret: "s" },
            environment_id: "env-abc123",
            organization_id: "org-xyz789",
            compute_pool_id: "lfcp-pool01",
          },
          telemetry: {
            endpoint: "https://api.telemetry.confluent.cloud",
            auth: { type: "api_key", key: "k", secret: "s" },
          },
        });
        expect(handler.enabledConnectionIds(runtime)).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection with flink but no telemetry block", () => {
        expect(handler.enabledConnectionIds(flinkRuntime())).toEqual([]);
      });

      it("should return an empty array for a connection without a flink block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });
    });
  });
});
