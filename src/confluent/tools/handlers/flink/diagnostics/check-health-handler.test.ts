import { CheckHealthHandler } from "@src/confluent/tools/handlers/flink/diagnostics/check-health-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  FLINK_CONN,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, it } from "vitest";

const EXPLICIT_IDS = {
  organizationId: "org-from-args",
  environmentId: "env-from-args",
};

const STATEMENT_NAME = "my-statement";

describe("check-health-handler.ts", () => {
  describe("CheckHealthHandler", () => {
    const handler = new CheckHealthHandler();

    describe("handle()", () => {
      const cases: HandleCaseWithConn[] = [
        {
          label: "throws ZodError when statementName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label: "throws when organizationId is absent and not in config",
          args: { statementName: STATEMENT_NAME },
          outcome: { throws: "Organization ID is required" },
          connectionConfig: {},
        },
        {
          label: "throws when environmentId is absent and not in config",
          args: {
            statementName: STATEMENT_NAME,
            organizationId: "org-from-args",
          },
          outcome: { throws: "Environment ID is required" },
          connectionConfig: {},
        },
        {
          label:
            "uses org/env IDs from config and reports healthy for running statement",
          args: { statementName: STATEMENT_NAME },
          responseData: { status: { phase: "RUNNING" }, data: [] },
          outcome: { resolves: `Health check for '${STATEMENT_NAME}'` },
        },
        {
          label: "uses explicit org/env args over config",
          args: { statementName: STATEMENT_NAME, ...EXPLICIT_IDS },
          responseData: { status: { phase: "RUNNING" }, data: [] },
          outcome: { resolves: `Health check for '${STATEMENT_NAME}'` },
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
    });
  });
});
