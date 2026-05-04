import { DescribeTableHandler } from "@src/confluent/tools/handlers/flink/catalog/describe-table-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  FLINK_CONN,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const TABLE_NAME = "my-table";

const SQL_RESPONSE = {
  status: { phase: "COMPLETED" },
  results: { data: [{ COLUMN_NAME: "id", DATA_TYPE: "BIGINT" }] },
};

describe("describe-table-handler.ts", () => {
  describe("DescribeTableHandler", () => {
    const handler = new DescribeTableHandler();

    describe("handle()", () => {
      const cases: HandleCaseWithConn[] = [
        {
          label: "throw ZodError when tableName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label: "throw when organizationId is absent and not in config",
          args: { tableName: TABLE_NAME },
          outcome: { throws: "Organization ID is required" },
          connectionConfig: {},
        },
        {
          label: "throw when environmentId is absent and not in config",
          args: { tableName: TABLE_NAME, organizationId: "org-from-args" },
          outcome: { throws: "Environment ID is required" },
          connectionConfig: {},
        },
        {
          label: "throw when computePoolId is absent and not in config",
          args: {
            tableName: TABLE_NAME,
            organizationId: "org-from-args",
            environmentId: "env-from-args",
          },
          outcome: { throws: "Compute Pool ID is required" },
          connectionConfig: {},
        },
        {
          label: "use org/env/compute IDs from config when args absent",
          args: { tableName: TABLE_NAME },
          outcome: { resolves: `Table '${TABLE_NAME}' schema` },
          responseData: SQL_RESPONSE,
        },
        {
          label: "use explicit org/env/compute args over config",
          args: {
            tableName: TABLE_NAME,
            organizationId: "org-from-args",
            environmentId: "env-from-args",
            computePoolId: "lfcp-from-args",
          },
          outcome: { resolves: `Table '${TABLE_NAME}' schema` },
          responseData: SQL_RESPONSE,
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

      it.each([
        {
          label: "use config environment_id when catalogName arg is absent",
          args: { tableName: TABLE_NAME },
          expectedCatalog: FLINK_CONN.flink.environment_id,
        },
        {
          label: "use explicit catalogName arg when provided",
          args: { tableName: TABLE_NAME, catalogName: "env-explicit" },
          expectedCatalog: "env-explicit",
        },
      ])(
        "should $label in POST SQL statement",
        async ({ args, expectedCatalog }) => {
          const { clientManager, clientGetters, capturedCalls } =
            stubClientGetters(SQL_RESPONSE);
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              FLINK_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome: { resolves: `Table '${TABLE_NAME}' schema` },
            clientGetters,
          });
          expect(capturedCalls).toHaveLength(3);
          expect(capturedCalls[0]!.args).toMatchObject({
            body: expect.objectContaining({
              spec: expect.objectContaining({
                statement: expect.stringContaining(expectedCatalog),
              }),
            }),
          });
        },
      );
    });
  });
});
