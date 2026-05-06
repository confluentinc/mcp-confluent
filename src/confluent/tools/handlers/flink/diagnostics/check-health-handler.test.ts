import { CheckHealthHandler } from "@src/confluent/tools/handlers/flink/diagnostics/check-health-handler.js";
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
import { describe, it } from "vitest";

const EXPLICIT_IDS = {
  organizationId: "org-from-args",
  environmentId: "env-from-args",
};

const STATEMENT_NAME = "my-statement";

type CheckHealthCase = HandleCaseWithConn & {
  /** Body returned by the Flink REST GET. Omit for cases that throw before
   *  reaching the client. */
  flinkGetData?: unknown;
};

describe("check-health-handler.ts", () => {
  describe("CheckHealthHandler", () => {
    const handler = new CheckHealthHandler();

    describe("handle()", () => {
      const cases: CheckHealthCase[] = [
        {
          label: "throws ZodError when statementName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label:
            "uses org/env IDs from config and reports healthy for running statement",
          args: { statementName: STATEMENT_NAME },
          flinkGetData: { status: { phase: "RUNNING" }, data: [] },
          outcome: { resolves: `Health check for '${STATEMENT_NAME}'` },
        },
        {
          label: "uses explicit org/env args over config",
          args: { statementName: STATEMENT_NAME, ...EXPLICIT_IDS },
          flinkGetData: { status: { phase: "RUNNING" }, data: [] },
          outcome: { resolves: `Health check for '${STATEMENT_NAME}'` },
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
    });
  });
});
