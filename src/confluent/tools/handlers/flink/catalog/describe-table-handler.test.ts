import { DescribeTableHandler } from "@src/confluent/tools/handlers/flink/catalog/describe-table-handler.js";
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

// Blanket response carrying both a terminal phase and a result row, so a single
// mockResolvedValue serves every GET (status poll + results fetch) of both the
// COLUMNS and the TABLES query this handler runs.
const SQL_RESPONSE = {
  status: { phase: "COMPLETED" },
  results: { data: [{ COLUMN_NAME: "id", DATA_TYPE: "BIGINT" }] },
};

describe("describe-table-handler.ts", () => {
  describe("DescribeTableHandler", () => {
    const handler = new DescribeTableHandler();

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
          outcome: { resolves: `Table '${TABLE_NAME}':` },
        },
        {
          label: "use explicit org/env/compute args over config",
          args: {
            tableName: TABLE_NAME,
            organizationId: "org-from-args",
            environmentId: "env-from-args",
            computePoolId: "lfcp-from-args",
          },
          outcome: { resolves: `Table '${TABLE_NAME}':` },
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

      it("should return both table metadata and column schema in one response", async () => {
        flinkRest.POST.mockResolvedValue({ data: {} });
        flinkRest.GET
          // COLUMNS query: status poll, then results
          .mockResolvedValueOnce({ data: { status: { phase: "COMPLETED" } } })
          .mockResolvedValueOnce({
            data: { results: { data: [{ COLUMN_NAME: "id" }] } },
          })
          // TABLES query: status poll, then results
          .mockResolvedValueOnce({ data: { status: { phase: "COMPLETED" } } })
          .mockResolvedValueOnce({
            data: {
              results: {
                data: [{ TABLE_TYPE: "BASE TABLE", IS_WATERMARKED: "YES" }],
              },
            },
          });

        const result = await handler.handle(
          runtimeWith(FLINK_CONN, DEFAULT_CONNECTION_ID, clientManager),
          { tableName: TABLE_NAME },
        );

        expect(result.isError).not.toBe(true);
        const text = (result.content[0] as { text: string }).text;
        const payload = JSON.parse(text.slice(text.indexOf("{")));
        expect(payload).toEqual({
          metadata: { TABLE_TYPE: "BASE TABLE", IS_WATERMARKED: "YES" },
          columns: [{ COLUMN_NAME: "id" }],
        });
        // one POST per query
        expect(flinkRest.POST).toHaveBeenCalledTimes(2);
      });

      it("should still return columns when the table-metadata query fails", async () => {
        flinkRest.POST.mockResolvedValue({ data: {} });
        flinkRest.GET
          // COLUMNS query succeeds
          .mockResolvedValueOnce({ data: { status: { phase: "COMPLETED" } } })
          .mockResolvedValueOnce({
            data: { results: { data: [{ COLUMN_NAME: "id" }] } },
          })
          // TABLES query fails
          .mockResolvedValueOnce({
            data: { status: { phase: "FAILED", detail: "metadata boom" } },
          });

        const result = await handler.handle(
          runtimeWith(FLINK_CONN, DEFAULT_CONNECTION_ID, clientManager),
          { tableName: TABLE_NAME },
        );

        expect(result.isError).not.toBe(true);
        const text = (result.content[0] as { text: string }).text;
        const payload = JSON.parse(text.slice(text.indexOf("{")));
        expect(payload).toEqual({
          metadata: null,
          columns: [{ COLUMN_NAME: "id" }],
        });
      });

      it("should surface a statement name per query via _meta.flinkStatementsCreated on success", async () => {
        const result = await handler.handle(
          runtimeWith(FLINK_CONN, DEFAULT_CONNECTION_ID, clientManager),
          { tableName: TABLE_NAME },
        );
        expect(result.isError).not.toBe(true);
        // one statement for the COLUMNS query, one for the TABLES query
        expect(result._meta?.flinkStatementsCreated).toEqual([
          expect.stringMatching(/^mcp-query-/),
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
        // columns query fails first, so the call errors before the metadata query runs
        expect(result.isError).toBe(true);
        expect(result._meta?.flinkStatementsCreated).toEqual([
          expect.stringMatching(/^mcp-query-/),
        ]);
      });

      it("should surface the resolver lookup plus both query statements when an lkc-* databaseName is given", async () => {
        const result = await handler.handle(
          runtimeWith(FLINK_CONN, DEFAULT_CONNECTION_ID, clientManager),
          { tableName: TABLE_NAME, databaseName: "lkc-explicit" },
        );
        expect(result.isError).not.toBe(true);
        // resolver lookup + COLUMNS query + TABLES query each mint a statement
        expect(result._meta?.flinkStatementsCreated).toEqual([
          expect.stringMatching(/^mcp-query-/),
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
            outcome: { resolves: `Table '${TABLE_NAME}':` },
            clientManager,
          });

          // one POST per query, both against the resolved catalog
          expect(flinkRest.POST).toHaveBeenCalledTimes(2);
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
