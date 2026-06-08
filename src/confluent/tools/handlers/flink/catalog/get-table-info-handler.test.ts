import { GetTableInfoHandler } from "@src/confluent/tools/handlers/flink/catalog/get-table-info-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  FLINK_CONN,
  HandleCaseWithConn,
  runtimeWith,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  type MockedClientManager,
  type MockedRestClient,
} from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const TABLE_NAME = "my-table";

const SQL_RESPONSE = {
  status: { phase: "COMPLETED" },
  results: { data: [{ TABLE_NAME, TABLE_TYPE: "BASE TABLE" }] },
};

describe("get-table-info-handler.ts", () => {
  describe("GetTableInfoHandler", () => {
    const handler = new GetTableInfoHandler();

    describe("handle()", () => {
      let clientManager: MockedClientManager;
      let flinkRest: MockedRestClient;

      beforeEach(() => {
        clientManager = getMockedClientManager();
        flinkRest = clientManager.getConfluentCloudFlinkRestClient();
        flinkRest.POST.mockResolvedValue({ data: SQL_RESPONSE });
        flinkRest.GET.mockResolvedValue({ data: SQL_RESPONSE });
      });

      const cases: HandleCaseWithConn[] = [
        {
          label: "throw ZodError when tableName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label: "use org/env/compute IDs from config when args absent",
          args: { tableName: TABLE_NAME },
          outcome: { resolves: `Table info for '${TABLE_NAME}'` },
        },
        {
          label: "use explicit org/env/compute args over config",
          args: {
            tableName: TABLE_NAME,
            organizationId: "org-from-args",
            environmentId: "env-from-args",
            computePoolId: "lfcp-from-args",
          },
          outcome: { resolves: `Table info for '${TABLE_NAME}'` },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({ args, outcome, connectionConfig = FLINK_CONN }) => {
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

      it("should surface the executeFlinkSql statement name via _meta.flinkStatementsCreated on success", async () => {
        const result = await handler.handle(
          runtimeWith(FLINK_CONN, DEFAULT_CONNECTION_ID, clientManager),
          { tableName: TABLE_NAME },
        );
        expect(result.isError).not.toBe(true);
        expect(result._meta?.flinkStatementsCreated).toEqual([
          expect.stringMatching(/^mcp-query-/),
        ]);
      });

      it("should still surface the statement name via _meta on the error path", async () => {
        flinkRest.GET.mockResolvedValue({
          data: {
            ...SQL_RESPONSE,
            status: { phase: "FAILED", detail: "synthetic failure" },
          },
        });
        const result = await handler.handle(
          runtimeWith(FLINK_CONN, DEFAULT_CONNECTION_ID, clientManager),
          { tableName: TABLE_NAME },
        );
        expect(result.isError).toBe(true);
        expect(result._meta?.flinkStatementsCreated).toEqual([
          expect.stringMatching(/^mcp-query-/),
        ]);
      });

      it("should surface BOTH statement names when an lkc-* databaseName triggers the resolver lookup", async () => {
        const result = await handler.handle(
          runtimeWith(FLINK_CONN, DEFAULT_CONNECTION_ID, clientManager),
          { tableName: TABLE_NAME, databaseName: "lkc-explicit" },
        );
        expect(result.isError).not.toBe(true);
        expect(result._meta?.flinkStatementsCreated).toEqual([
          expect.stringMatching(/^mcp-query-/),
          expect.stringMatching(/^mcp-query-/),
        ]);
      });

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
          await assertHandleCase({
            handler,
            runtime: runtimeWithDecoy(
              FLINK_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome: { resolves: `Table info for '${TABLE_NAME}'` },
            clientManager,
          });

          expect(flinkRest.POST).toHaveBeenCalledOnce();
          expect(flinkRest.POST).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
              body: expect.objectContaining({
                spec: expect.objectContaining({
                  statement: expect.stringContaining(expectedCatalog),
                }),
              }),
            }),
          );
        },
      );
    });
  });
});
