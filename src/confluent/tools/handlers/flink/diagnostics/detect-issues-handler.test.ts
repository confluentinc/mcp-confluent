import { DetectIssuesHandler } from "@src/confluent/tools/handlers/flink/diagnostics/detect-issues-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  stubClientGetters,
  type HandleCase,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

const STATEMENT_NAME = "my-statement";

type HandleCaseWithConn = HandleCase & {
  connectionConfig?: Parameters<typeof runtimeWith>[0];
};

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
          label: "reports no issues for a running statement",
          args: {
            statementName: STATEMENT_NAME,
            organizationId: "org-from-args",
            environmentId: "env-from-args",
            computePoolId: "lfcp-from-args",
            includeMetrics: false,
          },
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
            computePoolId: "lfcp-from-args",
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
          args: {
            statementName: STATEMENT_NAME,
            organizationId: "org-from-args",
            environmentId: "env-from-args",
            computePoolId: "lfcp-from-args",
            includeMetrics: true,
          },
          // Call 1: GET statement status; call 2: GET exceptions (reused for
          // all 13 subsequent telemetry POSTs since it is the last element).
          responseData: [{ status: { phase: "RUNNING" } }, { data: [] }],
          outcome: { resolves: "Metrics: No metrics data available" },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({ args, outcome, responseData, connectionConfig = {} }) => {
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
    });
  });
});
