import { GetFlinkExceptionsHandler } from "@src/confluent/tools/handlers/flink/get-flink-exceptions-handler.js";
import { initEnv } from "@src/env.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  stubClientGetters,
  type HandleCase,
} from "@tests/stubs/index.js";
import { beforeAll, describe, it } from "vitest";

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

describe("get-flink-exceptions-handler.ts", () => {
  describe("GetFlinkExceptionsHandler", () => {
    const handler = new GetFlinkExceptionsHandler();

    // Required while the handler reads env vars via getEnsuredParam.
    // Remove after issue #231 migrates those reads to conn.flink config fields.
    beforeAll(() => {
      initEnv();
    });

    describe("handle()", () => {
      const cases: HandleCase[] = [
        {
          label: "throws when statementName is absent",
          args: {},
          outcome: { throws: "ZodError" },
        },
        {
          label: "throws when organizationId is absent and not in env",
          args: { statementName: STATEMENT_NAME },
          outcome: { throws: "Organization ID is required" },
        },
        {
          label: "throws when environmentId is absent and not in env",
          args: {
            statementName: STATEMENT_NAME,
            organizationId: "org-from-args",
          },
          outcome: { throws: "Environment ID is required" },
        },
        {
          label: "resolves with no-exceptions message when data is empty",
          args: { statementName: STATEMENT_NAME, ...EXPLICIT_IDS },
          responseData: { data: [] },
          outcome: {
            resolves: `No exceptions found for statement '${STATEMENT_NAME}'.`,
          },
        },
        {
          label: "resolves with exception list when exceptions are present",
          args: { statementName: STATEMENT_NAME, ...EXPLICIT_IDS },
          responseData: {
            data: [{ message: "OOM error" }, { message: "Timeout" }],
          },
          outcome: {
            resolves: `Flink Statement Exceptions for '${STATEMENT_NAME}'`,
          },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({ args, outcome, responseData }) => {
          const { clientManager, clientGetters } =
            stubClientGetters(responseData);
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              FLINK_CONN,
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
