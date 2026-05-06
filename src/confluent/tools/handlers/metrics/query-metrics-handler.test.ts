import {
  buildEffectiveFilter,
  buildRequestBody,
  QueryMetricsHandler,
  resolveInterval,
} from "@src/confluent/tools/handlers/metrics/query-metrics-handler.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  runtimeWith,
  telemetryRuntime,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KAFKA_SERVER_METRIC = "io.confluent.kafka.server/received_bytes";

const TELEMETRY_CONN = {
  telemetry: {
    endpoint: "https://api.telemetry.confluent.cloud",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
  },
};

const TELEMETRY_WITH_KAFKA_CONN = {
  ...TELEMETRY_CONN,
  kafka: {
    cluster_id: "lkc-from-config",
    rest_endpoint: "https://pkc-xxxxx.us-east-1.aws.confluent.cloud:443",
  },
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

    describe("resolveInterval()", () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it("should pass through an already-resolved start/end interval unchanged", () => {
        const interval = "2024-01-01T00:00:00Z/2024-01-02T00:00:00Z";
        expect(resolveInterval(interval)).toBe(interval);
      });

      it("should default to the last 1 hour when interval is undefined", () => {
        vi.setSystemTime(new Date("2024-06-01T12:00:00.000Z"));
        expect(resolveInterval(undefined)).toBe(
          "2024-06-01T11:00:00.000Z/2024-06-01T12:00:00.000Z",
        );
      });

      it("should resolve an ISO 8601 duration to a start/end range ending now", () => {
        vi.setSystemTime(new Date("2024-06-01T12:00:00.000Z"));
        expect(resolveInterval("PT30M")).toBe(
          "2024-06-01T11:30:00.000Z/2024-06-01T12:00:00.000Z",
        );
      });
    });

    describe("buildEffectiveFilter()", () => {
      it("should inject cluster ID for Kafka server metrics when no filter is provided", () => {
        expect(
          buildEffectiveFilter(undefined, KAFKA_SERVER_METRIC, "lkc-abc"),
        ).toEqual({ "resource.kafka.id": "lkc-abc" });
      });

      it("should trim a space-padded resource.kafka.id and keep it over the config value", () => {
        const result = buildEffectiveFilter(
          { "resource.kafka.id": " lkc-explicit " },
          KAFKA_SERVER_METRIC,
          "lkc-from-config",
        );
        expect(result["resource.kafka.id"]).toBe("lkc-explicit");
      });

      it("should remove a whitespace-only resource.kafka.id and fall back to config", () => {
        const result = buildEffectiveFilter(
          { "resource.kafka.id": "   " },
          KAFKA_SERVER_METRIC,
          "lkc-from-config",
        );
        expect(result["resource.kafka.id"]).toBe("lkc-from-config");
      });

      it("should not inject for non-Kafka-server metrics even when cluster ID is in config", () => {
        const result = buildEffectiveFilter(
          undefined,
          "io.confluent.flink/num_records_in",
          "lkc-abc",
        );
        expect(result).not.toHaveProperty("resource.kafka.id");
      });
    });

    describe("buildRequestBody()", () => {
      const BASE_ARGS = [
        KAFKA_SERVER_METRIC,
        "SUM",
        "PT1M",
        "2024-01-01T00:00:00Z/2024-01-02T00:00:00Z",
        100,
      ] as const;

      it("should produce a flat EQ filter for a single filter entry", () => {
        const body = buildRequestBody(
          ...BASE_ARGS,
          { "resource.kafka.id": "lkc-abc" },
          undefined,
        );
        expect(body.filter).toEqual({
          field: "resource.kafka.id",
          op: "EQ",
          value: "lkc-abc",
        });
      });

      it("should wrap multiple filter entries in an AND object", () => {
        const body = buildRequestBody(
          ...BASE_ARGS,
          { "resource.kafka.id": "lkc-abc", "metric.topic": "my-topic" },
          undefined,
        );
        expect(body.filter).toMatchObject({
          op: "AND",
          filters: expect.arrayContaining([
            { field: "resource.kafka.id", op: "EQ", value: "lkc-abc" },
            { field: "metric.topic", op: "EQ", value: "my-topic" },
          ]),
        });
      });

      it("should omit filter when effectiveFilter is empty", () => {
        const body = buildRequestBody(...BASE_ARGS, {}, undefined);
        expect(body).not.toHaveProperty("filter");
      });

      it("should set GROUPED format when group_by is provided", () => {
        const body = buildRequestBody(...BASE_ARGS, {}, ["metric.topic"]);
        expect(body).toMatchObject({
          group_by: ["metric.topic"],
          format: "GROUPED",
        });
      });

      it("should not set format when group_by is absent", () => {
        const body = buildRequestBody(...BASE_ARGS, {}, undefined);
        expect(body).not.toHaveProperty("format");
      });
    });

    describe("handle()", () => {
      const cases: FilterCase[] = [
        {
          label:
            "auto-inject resource.kafka.id from config when no explicit filter is supplied",
          connectionConfig: TELEMETRY_WITH_KAFKA_CONN,
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
          connectionConfig: TELEMETRY_CONN,
          args: { metric: KAFKA_SERVER_METRIC },
          outcome: { resolves: "No data returned for metric" },
        },
        {
          label:
            "prefer an explicit resource.kafka.id filter arg over the connection config value",
          connectionConfig: TELEMETRY_WITH_KAFKA_CONN,
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
        {
          label:
            "not inject a filter for non-Kafka-server metrics even when cluster_id is in config",
          connectionConfig: TELEMETRY_WITH_KAFKA_CONN,
          args: { metric: "io.confluent.flink/num_records_in" },
          outcome: { resolves: "No data returned for metric" },
        },
        {
          label:
            "fall back to config when resource.kafka.id filter arg is whitespace-only",
          connectionConfig: TELEMETRY_WITH_KAFKA_CONN,
          args: {
            metric: KAFKA_SERVER_METRIC,
            filter: { "resource.kafka.id": "   " },
          },
          outcome: { resolves: "No data returned for metric" },
          expectedFilter: {
            field: "resource.kafka.id",
            op: "EQ",
            value: "lkc-from-config",
          },
        },
        {
          label:
            "send trimmed resource.kafka.id when caller passes a space-padded value",
          connectionConfig: TELEMETRY_WITH_KAFKA_CONN,
          args: {
            metric: KAFKA_SERVER_METRIC,
            filter: { "resource.kafka.id": " lkc-explicit " },
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
          const clientManager = getMockedClientManager();
          const telemetryRest =
            clientManager.getConfluentCloudTelemetryRestClient();
          telemetryRest.POST.mockResolvedValue({ data: {} });

          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              connectionConfig,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientManager,
          });

          expect(telemetryRest.POST).toHaveBeenCalledOnce();
          // expect.not.objectContaining lets us assert filter-absent without
          // reaching into mock.calls, which openapi-fetch's overloaded POST
          // collapses to `never` for TypeScript
          const expectedBody = expectedFilter
            ? expect.objectContaining({ filter: expectedFilter })
            : expect.not.objectContaining({ filter: expect.anything() });
          expect(telemetryRest.POST).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ body: expectedBody }),
          );
        },
      );
    });
  });
});
