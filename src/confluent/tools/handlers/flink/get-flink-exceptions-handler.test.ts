import { GetFlinkExceptionsHandler } from "@src/confluent/tools/handlers/flink/get-flink-exceptions-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  FLINK_CONN,
  FlinkGetCase,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

const STATEMENT_NAME = "my-statement";

const EXPLICIT_IDS = {
  organizationId: "org-from-args",
  environmentId: "env-from-args",
};

describe("get-flink-exceptions-handler.ts", () => {
  describe("GetFlinkExceptionsHandler", () => {
    const handler = new GetFlinkExceptionsHandler();

    describe("handle()", () => {
      const cases: FlinkGetCase[] = [
        {
          label: "throws ZodError when statementName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label: "uses org/env IDs from config when args absent",
          args: { statementName: STATEMENT_NAME },
          flinkGetData: { data: [] },
          outcome: {
            resolves: `No exceptions found for statement '${STATEMENT_NAME}'.`,
          },
        },
        {
          label:
            "uses explicit org/env args over config and returns exception list",
          args: { statementName: STATEMENT_NAME, ...EXPLICIT_IDS },
          flinkGetData: {
            data: [{ message: "OOM error" }, { message: "Timeout" }],
          },
          outcome: {
            resolves: `Flink Statement Exceptions for '${STATEMENT_NAME}'`,
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
            runtime: runtimeWithDecoy(
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
