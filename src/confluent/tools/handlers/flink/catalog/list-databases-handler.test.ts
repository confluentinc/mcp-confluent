import { ListDatabasesHandler } from "@src/confluent/tools/handlers/flink/catalog/list-databases-handler.js";
import { textOf } from "@tests/call-tool-result.js";
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

const SQL_RESPONSE = {
  status: { phase: "COMPLETED" },
  results: { data: [{ SCHEMA_ID: "1", SCHEMA_NAME: "my-cluster" }] },
};

describe("list-databases-handler.ts", () => {
  describe("ListDatabasesHandler", () => {
    const handler = new ListDatabasesHandler();

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
          label: "use org/env/compute IDs from config when args absent",
          args: {},
          outcome: { resolves: "Databases" },
        },
        {
          label: "use explicit org/env/compute args over config",
          args: {
            organizationId: "org-from-args",
            environmentId: "env-from-args",
            computePoolId: "lfcp-from-args",
          },
          outcome: { resolves: "Databases" },
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
          {},
        );
        expect(result.isError).not.toBe(true);
        expect(result._meta?.flinkStatementsCreated).toEqual([
          expect.stringMatching(/^mcp-query-/),
        ]);
      });

      it("should return a config error when the environment_id is not an env-* catalog", async () => {
        const conn = {
          flink: { ...FLINK_CONN.flink, environment_id: "friendly-env" },
        };
        const result = await handler.handle(
          runtimeWith(conn, DEFAULT_CONNECTION_ID, clientManager),
          {},
        );
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe(
          "Catalog name could not be resolved. Pass catalogName or environmentId as env-xxxxx, or set flink.environment_id in config.",
        );
      });

      it("should report 'No databases found.' when the query returns zero rows", async () => {
        flinkRest.GET.mockResolvedValue({
          data: { ...SQL_RESPONSE, results: { data: [] } },
        });
        const result = await handler.handle(
          runtimeWith(FLINK_CONN, DEFAULT_CONNECTION_ID, clientManager),
          {},
        );
        expect(result.isError).not.toBe(true);
        expect(textOf(result)).toBe("No databases found.");
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
          {},
        );
        expect(result.isError).toBe(true);
        expect(result._meta?.flinkStatementsCreated).toEqual([
          expect.stringMatching(/^mcp-query-/),
        ]);
      });

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
          await assertHandleCase({
            handler,
            runtime: runtimeWithDecoy(
              FLINK_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome: { resolves: "Databases" },
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
