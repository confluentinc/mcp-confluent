import { ListTablesHandler } from "@src/confluent/tools/handlers/flink/catalog/list-tables-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  FLINK_CONN,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const SQL_RESPONSE = {
  status: { phase: "COMPLETED" },
  results: {
    data: [{ TABLE_NAME: "my-table", TABLE_TYPE: "BASE TABLE" }],
  },
};

describe("list-tables-handler.ts", () => {
  describe("ListTablesHandler", () => {
    const handler = new ListTablesHandler();

    describe("handle()", () => {
      const cases: HandleCaseWithConn[] = [
        {
          label: "use org/env/compute IDs from config when args absent",
          args: {},
          outcome: { resolves: "Tables in catalog" },
          responseData: SQL_RESPONSE,
        },
        {
          label: "use explicit org/env/compute args over config",
          args: {
            organizationId: "org-from-args",
            environmentId: "env-from-args",
            computePoolId: "lfcp-from-args",
          },
          outcome: { resolves: "Tables in catalog" },
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
          args: {},
          expectedCatalog: FLINK_CONN.flink.environment_id,
        },
        {
          label: "use explicit catalogName arg when provided",
          args: { catalogName: "env-explicit" },
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
            outcome: { resolves: "Tables in catalog" },
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
