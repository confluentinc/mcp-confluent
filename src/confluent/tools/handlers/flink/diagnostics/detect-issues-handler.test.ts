import { DetectIssuesHandler } from "@src/confluent/tools/handlers/flink/diagnostics/detect-issues-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  FLINK_CONN,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const STATEMENT_NAME = "my-statement";

describe("detect-issues-handler.ts", () => {
  describe("DetectIssuesHandler", () => {
    const handler = new DetectIssuesHandler();

    describe("handle()", () => {
      const cases: HandleCaseWithConn[] = [
        {
          label: "throws ZodError when statementName is absent",
          args: {},
          outcome: { throws: "ZodError" },
        },
        {
          label:
            "uses org/env IDs from config when args absent and reports no issues for running statement",
          args: { statementName: STATEMENT_NAME, includeMetrics: false },
          responseData: { status: { phase: "RUNNING" }, data: [] },
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
          responseData: {
            status: { phase: "FAILED", detail: "OOM" },
            data: [],
          },
          outcome: {
            resolves: `Detected 1 issue(s) for statement '${STATEMENT_NAME}'`,
          },
        },
        {
          label:
            "runs metrics branch when includeMetrics is true and reports summary",
          args: { statementName: STATEMENT_NAME, includeMetrics: true },
          // Call 1: GET statement status; call 2: GET exceptions (reused for
          // all 13 subsequent telemetry POSTs since it is the last element).
          responseData: [{ status: { phase: "RUNNING" } }, { data: [] }],
          outcome: { resolves: "Metrics: No metrics data available" },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({
          args,
          outcome,
          responseData,
          connectionConfig = FLINK_CONN,
        }) => {
          const { clientManager, clientGetters } =
            stubClientGetters(responseData);
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
        },
      );

      it("should use explicit computePoolId in metrics POST body when arg is provided", async () => {
        const { clientManager, clientGetters, capturedCalls } =
          stubClientGetters([{ status: { phase: "RUNNING" } }, { data: [] }]);
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            statementName: STATEMENT_NAME,
            computePoolId: "lfcp-from-args",
            includeMetrics: true,
          },
          outcome: { resolves: "Metrics: No metrics data available" },
          clientGetters,
        });
        // calls 0+1 are the GET statement + GET exceptions; the telemetry POSTs follow
        const metricsCall = capturedCalls.find((c) =>
          c.pathTemplate.includes("/metrics/"),
        );
        expect(metricsCall).toBeDefined();
        expect(metricsCall!.args).toMatchObject({
          body: expect.objectContaining({
            filter: expect.objectContaining({
              filters: expect.arrayContaining([
                expect.objectContaining({
                  field: "resource.compute_pool.id",
                  value: "lfcp-from-args",
                }),
              ]),
            }),
          }),
        });
      });
    });
  });
});
