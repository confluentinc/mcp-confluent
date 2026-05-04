import { DeleteFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/delete-flink-statement-handler.js";
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

describe("delete-flink-statement-handler.ts", () => {
  describe("DeleteFlinkStatementHandler", () => {
    const handler = new DeleteFlinkStatementHandler();

    describe("handle()", () => {
      const cases: HandleCaseWithConn[] = [
        {
          label: "throw ZodError when statementName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label: "use org/env IDs from config when args absent",
          args: { statementName: STATEMENT_NAME },
          responseData: { response: { status: 204 } },
          outcome: { resolves: "Flink SQL Statement Deletion Status Code" },
        },
        {
          label: "use explicit org/env args over config",
          args: { statementName: STATEMENT_NAME, ...EXPLICIT_IDS },
          responseData: { response: { status: 204 } },
          outcome: { resolves: "Flink SQL Statement Deletion Status Code" },
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
