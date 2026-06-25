import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import {
  buildEffectiveFilter,
  buildRequestBody,
  QueryMetricsHandler,
  resolveInterval,
} from "@src/confluent/tools/handlers/metrics/query-metrics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { textOf } from "@tests/call-tool-result.js";
import {
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  runtimeWith,
  runtimeWithDecoy,
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

    describe("getToolConfig()", () => {
      it("should describe the query-metrics tool as read-only", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.QUERY_METRICS);
        expect(config.description).toContain("Confluent Cloud metrics");
        expect(config.inputSchema).toHaveProperty("metric");
        expect(config.annotations).toBe(READ_ONLY);
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

      it("should wrap multiple filter entries in an AND object preserving insertion order", () => {
        const body = buildRequestBody(
          ...BASE_ARGS,
          { "resource.kafka.id": "lkc-abc", "metric.topic": "my-topic" },
          undefined,
        );
        expect(body.filter).toEqual({
          op: "AND",
          filters: [
            { field: "resource.kafka.id", op: "EQ", value: "lkc-abc" },
            { field: "metric.topic", op: "EQ", value: "my-topic" },
          ],
        });
      });

      it("should omit filter when effectiveFilter is empty", () => {
        const body = buildRequestBody(...BASE_ARGS, {}, undefined);
        expect(body).not.toHaveProperty("filter");
      });

      it("should set GROUPED format when group_by is provided", () => {
        const body = buildRequestBody(...BASE_ARGS, {}, ["metric.topic"]);
        expect(body).toEqual({
          aggregations: [{ metric: KAFKA_SERVER_METRIC, agg: "SUM" }],
          granularity: "PT1M",
          intervals: ["2024-01-01T00:00:00Z/2024-01-02T00:00:00Z"],
          limit: 100,
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
            runtime: runtimeWithDecoy(
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
            "/v2/metrics/{dataset}/query",
            expect.objectContaining({
              params: { path: { dataset: "cloud" } },
              body: expectedBody,
            }),
          );
        },
      );
    });

    describe("handle() response shaping", () => {
      it("should return a flagged error when the telemetry API returns errors with detail", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudTelemetryRestClient()
          .POST.mockResolvedValue({
            data: {
              errors: [{ detail: "bad metric" }, { detail: "wrong dataset" }],
            },
          });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { metric: KAFKA_SERVER_METRIC },
          outcome: {
            resolves:
              "Metrics query returned errors: bad metric; wrong dataset",
            isError: true,
          },
          clientManager,
        });
      });

      it("should return a flagged error when the telemetry client throws", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudTelemetryRestClient()
          .POST.mockRejectedValue(new Error("network down"));

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { metric: KAFKA_SERVER_METRIC },
          outcome: {
            resolves: "Failed to query metrics: network down",
            isError: true,
          },
          clientManager,
        });
      });

      it("should stringify non-Error thrown values in the failure message", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudTelemetryRestClient()
          .POST.mockRejectedValue("boom");

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { metric: KAFKA_SERVER_METRIC },
          outcome: {
            resolves: "Failed to query metrics: boom",
            isError: true,
          },
          clientManager,
        });
      });

      it("should format flat results with integer locale separators and surface _meta with result_count", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudTelemetryRestClient()
          .POST.mockResolvedValue({
            data: {
              data: [
                { timestamp: "2024-06-01T12:00:00Z", value: 1234567 },
                { timestamp: "2024-06-01T12:01:00Z", value: 0.12345 },
                { timestamp: "2024-06-01T12:02:00Z" },
              ],
            },
          });

        const result = await handler.handle(
          runtimeWith(
            TELEMETRY_WITH_KAFKA_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          {
            metric: KAFKA_SERVER_METRIC,
            interval: "2024-06-01T11:00:00Z/2024-06-01T12:00:00Z",
          },
        );

        const text = textOf(result);
        expect(result.isError).toBe(false);
        expect(text).toContain("Metrics Query Results");
        expect(text).toContain(`Metric: ${KAFKA_SERVER_METRIC}`);
        expect(text).toContain(
          'Filter: {"resource.kafka.id":"lkc-from-config"}',
        );
        expect(text).toContain("Data Points: 3");
        expect(text).toContain((1234567).toLocaleString());
        expect(text).toContain("0.1235");
        expect(text).toContain("2024-06-01T12:02:00.000Z: N/A");
        expect(result._meta).toEqual({
          metric: KAFKA_SERVER_METRIC,
          dataset: "cloud",
          aggregation: "SUM",
          granularity: "PT1M",
          interval: "2024-06-01T11:00:00Z/2024-06-01T12:00:00Z",
          result_count: 3,
        });
      });

      it("should format grouped results with labels, group_by header, and an empty-points marker", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudTelemetryRestClient()
          .POST.mockResolvedValue({
            data: {
              data: [
                {
                  "metric.topic": "orders",
                  points: [
                    { timestamp: "2024-06-01T12:00:00Z", value: 42 },
                    { timestamp: "2024-06-01T12:01:00Z" },
                  ],
                },
                {
                  "metric.topic": "shipments",
                  points: [],
                },
              ],
            },
          });

        const result = await handler.handle(
          runtimeWith(TELEMETRY_CONN, DEFAULT_CONNECTION_ID, clientManager),
          {
            metric: KAFKA_SERVER_METRIC,
            interval: "2024-06-01T11:00:00Z/2024-06-01T12:00:00Z",
            group_by: ["metric.topic"],
          },
        );

        const text = textOf(result);
        expect(text).toContain("Group by: metric.topic");
        expect(text).toContain("Groups: 2");
        expect(text).toContain("Group: metric.topic=orders");
        expect(text).toContain("42");
        expect(text).toContain("2024-06-01T12:01:00.000Z: N/A");
        expect(text).toContain("Group: metric.topic=shipments");
        expect(text).toContain("(no data points)");
      });
    });
  });
});
