import { OAuthClientManager } from "@src/confluent/oauth-client-manager.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { ListMetricsHandler } from "@src/confluent/tools/handlers/metrics/list-metrics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { textOf } from "@tests/call-tool-result.js";
import {
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  getMockedRestClient,
  type MockedRestClient,
} from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it, type Mocked } from "vitest";

const TELEMETRY_CONN = {
  telemetry: {
    endpoint: "https://api.telemetry.confluent.cloud",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
  },
};

const KAFKA_METRIC_DESCRIPTOR = {
  name: "io.confluent.kafka.server/received_bytes",
  description: "Bytes received",
  type: "GAUGE_DOUBLE",
  unit: "By",
  lifecycle_stage: "GENERAL_AVAILABILITY",
  resources: ["kafka"],
  labels: [{ key: "topic", description: "Kafka topic name" }],
};

const FLINK_METRIC_DESCRIPTOR = {
  name: "io.confluent.flink/num_records_in",
  description: "Records in",
  type: "COUNTER_INT64",
  unit: "1",
  lifecycle_stage: "GENERAL_AVAILABILITY",
  resources: ["flink_statement"],
  labels: [],
};

const KAFKA_RESOURCE = {
  type: "kafka",
  description: "A Kafka cluster",
  labels: [{ key: "id", description: "Cluster ID" }],
};

const FLINK_RESOURCE = {
  type: "flink_statement",
  description: "A Flink SQL statement",
  labels: [],
};

function stubDescriptors(
  client: MockedRestClient,
  metrics: unknown,
  resources: unknown,
): void {
  client.GET.mockImplementation(((path: string) => {
    if (path.includes("/descriptors/metrics")) {
      return Promise.resolve({ data: { data: metrics } });
    }
    if (path.includes("/descriptors/resources")) {
      return Promise.resolve({ data: { data: resources } });
    }
    throw new Error(`unexpected path ${path}`);
  }) as MockedRestClient["GET"]);
}

describe("list-metrics-handler.ts", () => {
  describe("ListMetricsHandler", () => {
    const handler = new ListMetricsHandler();

    describe("getToolConfig()", () => {
      it("should describe the list-available-metrics tool as read-only", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.LIST_METRICS);
        expect(config.description).toContain("Confluent Cloud metrics");
        expect(config.inputSchema).toHaveProperty("resource_type");
        expect(config.annotations).toBe(READ_ONLY);
      });
    });

    describe("handle()", () => {
      let clientManager: ReturnType<typeof getMockedClientManager>;
      let telemetryRest: MockedRestClient;

      beforeEach(() => {
        clientManager = getMockedClientManager();
        telemetryRest = clientManager.getConfluentCloudTelemetryRestClient();
      });

      it("should return a flagged error when the metrics descriptor list is empty", async () => {
        stubDescriptors(telemetryRest, [], []);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          outcome: {
            resolves: "No metrics descriptors available",
            isError: true,
          },
          clientManager,
        });
      });

      it("should return a flagged error when the metrics descriptor data is undefined", async () => {
        stubDescriptors(telemetryRest, undefined, undefined);

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          outcome: {
            resolves: "No metrics descriptors available",
            isError: true,
          },
          clientManager,
        });
      });

      it("should prepend well-known Kafka server metrics when no resource_type is specified and no kafka.server entries are present", async () => {
        stubDescriptors(
          telemetryRest,
          [FLINK_METRIC_DESCRIPTOR],
          [KAFKA_RESOURCE, FLINK_RESOURCE],
        );

        const result = await handler.handle(
          runtimeWith(TELEMETRY_CONN, DEFAULT_CONNECTION_ID, clientManager),
          {},
        );

        const text = textOf(result);
        expect(result.isError).toBe(false);
        expect(text).toContain("Resource Types and Filter Fields:");
        expect(text).toContain("kafka: A Kafka cluster");
        expect(text).toContain("resource.id — Cluster ID");
        expect(text).toContain("flink_statement: A Flink SQL statement");
        expect(text).toContain("io.confluent.kafka.server/received_bytes");
        expect(text).toContain(
          "io.confluent.kafka.server/active_connection_count",
        );
        expect(text).toContain("io.confluent.flink/num_records_in");
        expect(text).toContain("Filter/group_by labels: metric.topic");
      });

      it("should filter to a single resource_type and not inject kafka fallback for non-kafka filters", async () => {
        stubDescriptors(
          telemetryRest,
          [KAFKA_METRIC_DESCRIPTOR, FLINK_METRIC_DESCRIPTOR],
          [KAFKA_RESOURCE, FLINK_RESOURCE],
        );

        const result = await handler.handle(
          runtimeWith(TELEMETRY_CONN, DEFAULT_CONNECTION_ID, clientManager),
          { resource_type: "flink_statement" },
        );

        const text = textOf(result);
        expect(text).toContain("Available Metrics (flink_statement): 1");
        expect(text).toContain("io.confluent.flink/num_records_in");
        expect(text).not.toContain("io.confluent.kafka.server/received_bytes");
        expect(text).toContain("flink_statement: A Flink SQL statement");
        expect(text).not.toContain("kafka: A Kafka cluster");
      });

      it("should not duplicate kafka.server fallback when descriptor data already includes a kafka.server metric", async () => {
        stubDescriptors(telemetryRest, [KAFKA_METRIC_DESCRIPTOR], []);

        const result = await handler.handle(
          runtimeWith(TELEMETRY_CONN, DEFAULT_CONNECTION_ID, clientManager),
          { resource_type: "kafka" },
        );

        const text = textOf(result);
        expect(text).toContain("Available Metrics (kafka): 1");
        const occurrences =
          text.split("io.confluent.kafka.server/received_bytes").length - 1;
        expect(occurrences).toBe(1);
      });

      it("should omit the resources section when descriptors return no resources", async () => {
        stubDescriptors(telemetryRest, [FLINK_METRIC_DESCRIPTOR], []);

        const result = await handler.handle(
          runtimeWith(TELEMETRY_CONN, DEFAULT_CONNECTION_ID, clientManager),
          { resource_type: "flink_statement" },
        );

        const text = textOf(result);
        expect(text).not.toContain("Resource Types and Filter Fields:");
        expect(text).toContain("Available Metrics (flink_statement): 1");
      });

      it("should surface a flagged error message when the telemetry client throws", async () => {
        telemetryRest.GET.mockRejectedValue(new Error("boom"));

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          outcome: { resolves: "Failed to list metrics: boom", isError: true },
          clientManager,
        });
      });

      it("should surface the HTTP status and error detail when the descriptors endpoint returns an openapi-fetch error instead of throwing", async () => {
        telemetryRest.GET.mockResolvedValue({
          error: { errors: [{ detail: "authentication failed" }] },
          response: { status: 403 },
        } as never);

        const result = await handler.handle(
          runtimeWith(TELEMETRY_CONN, DEFAULT_CONNECTION_ID, clientManager),
          {},
        );

        const text = textOf(result);
        expect(result.isError).toBe(true);
        expect(text).toContain("Failed to list metrics");
        expect(text).toContain("HTTP 403");
        expect(text).toContain("authentication failed");
        expect(text).not.toContain("No metrics descriptors available");
      });

      it("should preserve an Error payload's message rather than JSON-stringifying it to {}", async () => {
        telemetryRest.GET.mockResolvedValue({
          error: new Error("token expired"),
          response: { status: 500 },
        } as never);

        const result = await handler.handle(
          runtimeWith(TELEMETRY_CONN, DEFAULT_CONNECTION_ID, clientManager),
          {},
        );

        const text = textOf(result);
        expect(result.isError).toBe(true);
        expect(text).toContain("HTTP 500");
        expect(text).toContain("token expired");
        expect(text).not.toContain("{}");
      });

      it("should not throw when the descriptor error payload is a circular structure", async () => {
        const circular: Record<string, unknown> = {};
        circular.self = circular;
        telemetryRest.GET.mockResolvedValue({
          error: circular,
          response: { status: 500 },
        } as never);

        const result = await handler.handle(
          runtimeWith(TELEMETRY_CONN, DEFAULT_CONNECTION_ID, clientManager),
          {},
        );

        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("Failed to list metrics");
        expect(textOf(result)).toContain("HTTP 500");
      });

      it("should stringify non-Error thrown values in the failure message", async () => {
        telemetryRest.GET.mockRejectedValue("string failure");

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            TELEMETRY_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          outcome: {
            resolves: "Failed to list metrics: string failure",
            isError: true,
          },
          clientManager,
        });
      });
    });

    describe("handle() under OAuth", () => {
      it("should resolve the telemetry client from an OAuth connection (OAuth wiring)", async () => {
        const runtime = ccloudOAuthRuntime();
        const clientManager = runtime.clientManagers[
          DEFAULT_CONNECTION_ID
        ] as Mocked<OAuthClientManager>;
        const telemetryRest = getMockedRestClient();
        stubDescriptors(telemetryRest, [FLINK_METRIC_DESCRIPTOR], []);
        clientManager.getConfluentCloudTelemetryRestClient.mockReturnValue(
          telemetryRest,
        );

        const result = await handler.handle(runtime, {
          resource_type: "flink_statement",
        });

        expect(
          clientManager.getConfluentCloudTelemetryRestClient,
        ).toHaveBeenCalled();
        expect(textOf(result)).toContain("io.confluent.flink/num_records_in");
      });
    });
  });
});
