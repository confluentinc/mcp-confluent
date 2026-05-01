import { ReadFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/read-flink-statement-handler.js";
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

const FLINK_CONN = {
  flink: {
    endpoint: "https://flink.example.com",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
    environment_id: "env-from-config",
    organization_id: "org-from-config",
    compute_pool_id: "lfcp-from-config",
  },
};

const EXPLICIT_IDS = {
  organizationId: "org-from-args",
  environmentId: "env-from-args",
};

const STATEMENT_NAME = "my-statement";

type HandleCaseWithConn = HandleCase & {
  connectionConfig?: Parameters<typeof runtimeWith>[0];
};

describe("read-flink-statement-handler.ts", () => {
  describe("ReadFlinkStatementHandler", () => {
    const handler = new ReadFlinkStatementHandler();

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
          label: "uses org/env IDs from config when args absent",
          args: { statementName: STATEMENT_NAME, timeoutInMilliseconds: 0 },
          responseData: { results: { data: [] }, metadata: {} },
          outcome: { resolves: "Flink SQL Statement Results" },
        },
        {
          label: "uses explicit org/env args over config",
          args: {
            statementName: STATEMENT_NAME,
            timeoutInMilliseconds: 0,
            ...EXPLICIT_IDS,
          },
          responseData: { results: { data: [] }, metadata: {} },
          outcome: { resolves: "Flink SQL Statement Results" },
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
