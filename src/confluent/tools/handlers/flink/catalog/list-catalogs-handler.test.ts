import { ListCatalogsHandler } from "@src/confluent/tools/handlers/flink/catalog/list-catalogs-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  FLINK_CONN,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  type MockedClientManager,
  type MockedRestClient,
} from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const SQL_RESPONSE = {
  status: { phase: "COMPLETED" },
  results: { data: [{ CATALOG_NAME: "env-from-config" }] },
};

describe("list-catalogs-handler.ts", () => {
  describe("ListCatalogsHandler", () => {
    const handler = new ListCatalogsHandler();

    describe("handle()", () => {
      let clientManager: MockedClientManager;
      let flinkRest: MockedRestClient;

      beforeEach(() => {
        // executeFlinkSql does POST (submit) → GET (poll status) → GET (results)
        clientManager = getMockedClientManager();
        flinkRest = clientManager.getConfluentCloudFlinkRestClient();
        flinkRest.POST.mockResolvedValue({ data: SQL_RESPONSE });
        flinkRest.GET.mockResolvedValue({ data: SQL_RESPONSE });
      });

      const cases: HandleCaseWithConn[] = [
        {
          label: "use org/env/compute IDs from config when args absent",
          args: {},
          outcome: { resolves: "Catalogs" },
        },
        {
          label: "use explicit org/env/compute args over config",
          args: {
            organizationId: "org-from-args",
            environmentId: "env-from-args",
            computePoolId: "lfcp-from-args",
          },
          outcome: { resolves: "Catalogs" },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({ args, outcome, connectionConfig = FLINK_CONN }) => {
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

      it("should surface the executeFlinkSql statement name via _meta.flinkStatementsCreated on success", async () => {
        const result = await handler.handle(
          runtimeWith(FLINK_CONN, DEFAULT_CONNECTION_ID, clientManager),
          {},
        );
        expect(result.isError).not.toBe(true);
        // statement name is minted client-side by executeFlinkSql via Date.now()
        // + Math.random(), so it's genuinely non-deterministic from the test's
        // POV; pin only the prefix the cleanup script keys on
        expect(result._meta?.flinkStatementsCreated).toEqual([
          expect.stringMatching(/^mcp-query-/),
        ]);
      });

      it("should still surface the statement name via _meta on the error path", async () => {
        // status poll returning FAILED forces executeFlinkSql into its
        // error-with-statementName branch (statement was created, just bombed)
        flinkRest.GET.mockResolvedValue({
          data: {
            ...SQL_RESPONSE,
            status: { phase: "FAILED", detail: "synthetic failure" },
          },
        });
        const result = await handler.handle(
          runtimeWith(FLINK_CONN, DEFAULT_CONNECTION_ID, clientManager),
          {},
        );
        expect(result.isError).toBe(true);
        expect(result._meta?.flinkStatementsCreated).toEqual([
          expect.stringMatching(/^mcp-query-/),
        ]);
      });

      it("should embed config environment_id as catalog name in the POST SQL statement", async () => {
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: { resolves: "Catalogs" },
          clientManager,
        });

        expect(flinkRest.POST).toHaveBeenCalledOnce();
        expect(flinkRest.POST).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({
              spec: expect.objectContaining({
                statement: expect.stringContaining(
                  FLINK_CONN.flink.environment_id,
                ),
              }),
            }),
          }),
        );
      });
    });
  });
});
