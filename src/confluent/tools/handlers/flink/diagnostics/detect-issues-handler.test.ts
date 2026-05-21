import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { DetectIssuesHandler } from "@src/confluent/tools/handlers/flink/diagnostics/detect-issues-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  DEFAULT_CONNECTION_ID,
  FLINK_CONN,
  FlinkGetCase,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  type MockedClientManager,
} from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const STATEMENT_NAME = "my-statement";

/** Wire two Flink GETs (statement, exceptions) for handle() invocations
 *  whose tests don't enable metrics. */
function wireFlinkPair(
  cm: MockedClientManager,
  statement: unknown,
  exceptions: Array<Record<string, unknown>> = [],
): void {
  cm.getConfluentCloudFlinkRestClient()
    .GET.mockResolvedValueOnce({ data: statement })
    .mockResolvedValueOnce({ data: { data: exceptions } });
}

describe("detect-issues-handler.ts", () => {
  describe("DetectIssuesHandler", () => {
    const handler = new DetectIssuesHandler();

    describe("getToolConfig()", () => {
      it("should describe the detect-flink-statement-issues tool as read-only", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.DETECT_FLINK_STATEMENT_ISSUES);
        expect(config.description).toContain("Detect issues");
        expect(config.inputSchema).toHaveProperty("statementName");
        expect(config.inputSchema).toHaveProperty("includeMetrics");
        expect(config.annotations).toBe(READ_ONLY);
      });
    });

    describe("handle()", () => {
      const cases: FlinkGetCase[] = [
        {
          label: "throws ZodError when statementName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label:
            "uses org/env IDs from config when args absent and reports no issues for running statement",
          args: { statementName: STATEMENT_NAME, includeMetrics: false },
          flinkGetData: { status: { phase: "RUNNING" }, data: [] },
          outcome: {
            resolves: `No issues detected for statement '${STATEMENT_NAME}'. Statement is running normally.`,
          },
        },
        {
          label: "detects issues when statement phase is FAILED",
          args: {
            statementName: STATEMENT_NAME,
            organizationId: "org-from-args",
            environmentId: "env-from-args",
            includeMetrics: false,
          },
          flinkGetData: {
            status: { phase: "FAILED", detail: "OOM" },
            data: [],
          },
          outcome: {
            resolves: `Detected 1 issue(s) for statement '${STATEMENT_NAME}'`,
          },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({
          args,
          outcome,
          flinkGetData,
          connectionConfig = FLINK_CONN,
        }) => {
          const clientManager = getMockedClientManager();
          if (flinkGetData !== undefined) {
            clientManager
              .getConfluentCloudFlinkRestClient()
              .GET.mockResolvedValue({ data: flinkGetData });
          }
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
        },
      );

      // Metrics branch: includeMetrics: true triggers a poll-then-fetch on the
      // Flink REST client (RUNNING status → empty exceptions list) followed by
      // telemetry POSTs. The cases below cover both the config-fallback and
      // explicit-arg paths for resource.compute_pool.id in the POST body.
      it.each([
        {
          label: "use config computePoolId when arg is absent",
          args: { statementName: STATEMENT_NAME, includeMetrics: true },
          expectedComputePoolId: FLINK_CONN.flink.compute_pool_id,
        },
        {
          label: "use explicit computePoolId arg over config",
          args: {
            statementName: STATEMENT_NAME,
            computePoolId: "lfcp-from-args",
            includeMetrics: true,
          },
          expectedComputePoolId: "lfcp-from-args",
        },
      ])(
        "should $label in metrics POST body",
        async ({ args, expectedComputePoolId }) => {
          const clientManager = getMockedClientManager();
          const flinkRest = clientManager.getConfluentCloudFlinkRestClient();
          flinkRest.GET.mockResolvedValueOnce({
            data: { status: { phase: "RUNNING" } },
          }).mockResolvedValue({ data: { data: [] } });
          const telemetryRest =
            clientManager.getConfluentCloudTelemetryRestClient();
          telemetryRest.POST.mockResolvedValue({ data: { data: [] } });

          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              FLINK_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome: { resolves: "Metrics: No metrics data available" },
            clientManager,
          });

          expect(telemetryRest.POST).toHaveBeenCalledWith(
            expect.stringContaining("/metrics/"),
            expect.objectContaining({
              body: expect.objectContaining({
                filter: expect.objectContaining({
                  filters: expect.arrayContaining([
                    expect.objectContaining({
                      field: "resource.compute_pool.id",
                      value: expectedComputePoolId,
                    }),
                  ]),
                }),
              }),
            }),
          );
        },
      );

      describe("phase-based issues", () => {
        let clientManager: MockedClientManager;
        beforeEach(() => {
          clientManager = getMockedClientManager();
        });

        it("should flag FAILING phase as high severity", async () => {
          wireFlinkPair(clientManager, {
            status: { phase: "FAILING", detail: "downstream" },
          });
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              FLINK_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args: { statementName: STATEMENT_NAME, includeMetrics: false },
            outcome: { resolves: "statement_failing" },
            clientManager,
          });
        });

        it("should flag DEGRADED phase as high severity", async () => {
          wireFlinkPair(clientManager, { status: { phase: "DEGRADED" } });
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              FLINK_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args: { statementName: STATEMENT_NAME, includeMetrics: false },
            outcome: { resolves: "statement_degraded" },
            clientManager,
          });
        });

        it("should flag STOPPED phase as medium severity", async () => {
          wireFlinkPair(clientManager, { status: { phase: "STOPPED" } });
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              FLINK_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args: { statementName: STATEMENT_NAME, includeMetrics: false },
            outcome: { resolves: "statement_stopped" },
            clientManager,
          });
        });

        it("should surface error-keyword detail on a non-failing phase as status_warning", async () => {
          wireFlinkPair(clientManager, {
            status: { phase: "RUNNING", detail: "please contact support" },
          });
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              FLINK_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args: { statementName: STATEMENT_NAME, includeMetrics: false },
            outcome: { resolves: "status_warning" },
            clientManager,
          });
        });

        it("should not flag a non-failing phase with benign detail text", async () => {
          wireFlinkPair(clientManager, {
            status: { phase: "RUNNING", detail: "all good" },
          });
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              FLINK_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args: { statementName: STATEMENT_NAME, includeMetrics: false },
            outcome: { resolves: "running normally" },
            clientManager,
          });
        });

        it("should report no issues with a non-running terminal-but-clean phase", async () => {
          wireFlinkPair(clientManager, { status: { phase: "COMPLETED" } });
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              FLINK_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args: { statementName: STATEMENT_NAME, includeMetrics: false },
            outcome: {
              resolves: `No issues detected for statement '${STATEMENT_NAME}'. Current phase: COMPLETED`,
            },
            clientManager,
          });
        });
      });

      describe("exception pattern matching", () => {
        const patternCases: Array<{
          label: string;
          exceptions: Array<Record<string, string>>;
          expected: string;
        }> = [
          {
            label: "memory_issue from OutOfMemory message",
            exceptions: [{ message: "OutOfMemory: heap" }],
            expected: "memory_issue",
          },
          {
            label: "memory_issue from OutOfMemoryError name",
            exceptions: [{ name: "OutOfMemoryError", message: "x" }],
            expected: "memory_issue",
          },
          {
            label: "timeout pattern",
            exceptions: [{ message: "request timeout" }],
            expected: "timeout",
          },
          {
            label: "serialization_error pattern",
            exceptions: [{ message: "Serialization failed" }],
            expected: "serialization_error",
          },
          {
            label: "permission_error from Access denied",
            exceptions: [{ message: "Access denied" }],
            expected: "permission_error",
          },
          {
            label: "resource_not_found from 'not found'",
            exceptions: [{ message: "topic not found" }],
            expected: "resource_not_found",
          },
        ];

        it.each(patternCases)(
          "should detect $label",
          async ({ exceptions, expected }) => {
            const cm = getMockedClientManager();
            wireFlinkPair(cm, { status: { phase: "RUNNING" } }, exceptions);
            await assertHandleCase({
              handler,
              runtime: runtimeWith(FLINK_CONN, DEFAULT_CONNECTION_ID, cm),
              args: { statementName: STATEMENT_NAME, includeMetrics: false },
              outcome: { resolves: expected },
              clientManager: cm,
            });
          },
        );

        it("should detect frequent_exceptions when 5+ exceptions present", async () => {
          const cm = getMockedClientManager();
          const exceptions = Array.from({ length: 5 }, (_, i) => ({
            message: `exc-${i}`,
          }));
          wireFlinkPair(cm, { status: { phase: "RUNNING" } }, exceptions);
          await assertHandleCase({
            handler,
            runtime: runtimeWith(FLINK_CONN, DEFAULT_CONNECTION_ID, cm),
            args: { statementName: STATEMENT_NAME, includeMetrics: false },
            outcome: { resolves: "frequent_exceptions" },
            clientManager: cm,
          });
        });
      });

      it("should return an error response when the status GET errors", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudFlinkRestClient()
          .GET.mockResolvedValueOnce({ error: { code: 500 } });
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { statementName: STATEMENT_NAME, includeMetrics: false },
          outcome: {
            resolves: "Failed to get statement status",
            isError: true,
          },
          clientManager,
        });
      });

      it("should fold metrics-helper issues into the issue list when metrics analysis finds problems", async () => {
        const clientManager = getMockedClientManager();
        const flinkRest = clientManager.getConfluentCloudFlinkRestClient();
        flinkRest.GET.mockResolvedValueOnce({
          data: { status: { phase: "RUNNING" } },
        }).mockResolvedValueOnce({ data: { data: [] } });

        // Telemetry: first POST is pending_records (high backpressure metric)
        // — the helper queries 13 metrics sequentially. To trigger an issue
        // from analyzeMetrics, return a high pending_records value on the
        // appropriate iteration. Simpler: return the same response for every
        // call where the metric name in the body matches what we want to
        // trigger. We use a per-call implementation that inspects the
        // requested metric name.
        const telemetryRest =
          clientManager.getConfluentCloudTelemetryRestClient();
        telemetryRest.POST.mockImplementation(
          (
            _path: unknown,
            opts: unknown,
          ): Promise<{ data?: unknown; error?: unknown }> => {
            const o = opts as {
              body?: { aggregations?: Array<{ metric?: string }> };
            };
            const metric = o.body?.aggregations?.[0]?.metric ?? "";
            if (metric.includes("pending_records")) {
              return Promise.resolve({
                data: {
                  data: [{ points: [{ value: 2_000_000, timestamp: "t" }] }],
                },
              });
            }
            return Promise.resolve({ data: { data: [] } });
          },
        );

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { statementName: STATEMENT_NAME, includeMetrics: true },
          outcome: { resolves: "high_lag" },
          clientManager,
        });
      });
    });
  });
});
