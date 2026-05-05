import { QueryMetricsHandler } from "@src/confluent/tools/handlers/metrics/query-metrics-handler.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  runtimeWith,
  telemetryRuntime,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const KAFKA_SERVER_METRIC = "io.confluent.kafka.server/received_bytes";

const WITH_KAFKA_CLUSTER_ID = {
  kafka: { cluster_id: "lkc-from-config" },
};

type FilterCase = HandleCaseWithConn & {
  expectedFilter?: { field: string; op: string; value: string };
};

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

    describe("handle()", () => {
      const cases: FilterCase[] = [
        {
          label:
            "auto-inject resource.kafka.id from config when no explicit filter is supplied",
          connectionConfig: WITH_KAFKA_CLUSTER_ID,
          args: { metric: KAFKA_SERVER_METRIC },
          outcome: { resolves: "No data returned for metric" },
          expectedFilter: {
            field: "resource.kafka.id",
            op: "EQ",
            value: "lkc-from-config",
          },
        },
        {
          label:
            "not inject a filter when both the arg filter and conn kafka.cluster_id are absent",
          connectionConfig: {},
          args: { metric: KAFKA_SERVER_METRIC },
          outcome: { resolves: "No data returned for metric" },
        },
        {
          label:
            "prefer an explicit resource.kafka.id filter arg over the connection config value",
          connectionConfig: WITH_KAFKA_CLUSTER_ID,
          args: {
            metric: KAFKA_SERVER_METRIC,
            filter: { "resource.kafka.id": "lkc-explicit" },
          },
          outcome: { resolves: "No data returned for metric" },
          expectedFilter: {
            field: "resource.kafka.id",
            op: "EQ",
            value: "lkc-explicit",
          },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({ connectionConfig = {}, args, outcome, expectedFilter }) => {
          const { clientManager, clientGetters, capturedCalls } =
            stubClientGetters({});
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              connectionConfig,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientGetters,
          });
          expect(capturedCalls).toHaveLength(1);
          const body = (
            capturedCalls[0]!.args as { body: Record<string, unknown> }
          ).body;
          if (expectedFilter) {
            expect(body).toMatchObject({ filter: expectedFilter });
          } else {
            expect(body).not.toHaveProperty("filter");
          }
        },
      );
    });
  });
});
