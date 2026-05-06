import { DetectIssuesHandler } from "@src/confluent/tools/handlers/flink/diagnostics/detect-issues-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  FLINK_CONN,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const STATEMENT_NAME = "my-statement";

type IssuesCase = HandleCaseWithConn & {
  /** Body returned by the Flink REST GET. Omit for cases that throw before
   *  reaching the client. */
  flinkGetData?: unknown;
};

describe("detect-issues-handler.ts", () => {
  describe("DetectIssuesHandler", () => {
    const handler = new DetectIssuesHandler();

    describe("handle()", () => {
      const cases: IssuesCase[] = [
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
    });
  });
});
