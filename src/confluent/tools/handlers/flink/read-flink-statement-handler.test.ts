import { ReadFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/read-flink-statement-handler.js";
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

type ReadStatementCase = HandleCaseWithConn & {
  /** Body returned by the Flink REST GET. Omit for cases that throw before
   *  reaching the client. */
  flinkGetData?: unknown;
};

describe("read-flink-statement-handler.ts", () => {
  describe("ReadFlinkStatementHandler", () => {
    const handler = new ReadFlinkStatementHandler();

    describe("handle()", () => {
      const cases: ReadStatementCase[] = [
        {
          label: "throws ZodError when statementName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label: "uses org/env IDs from config when args absent",
          args: { statementName: STATEMENT_NAME, timeoutInMilliseconds: 0 },
          flinkGetData: { results: { data: [] }, metadata: {} },
          outcome: { resolves: "Flink SQL Statement Results" },
        },
        {
          label: "uses explicit org/env args over config",
          args: {
            statementName: STATEMENT_NAME,
            timeoutInMilliseconds: 0,
            ...EXPLICIT_IDS,
          },
          flinkGetData: { results: { data: [] }, metadata: {} },
          outcome: { resolves: "Flink SQL Statement Results" },
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
