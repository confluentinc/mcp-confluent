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
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const SQL_RESPONSE = {
  status: { phase: "COMPLETED" },
  results: { data: [{ CATALOG_NAME: "env-from-config" }] },
};

describe("list-catalogs-handler.ts", () => {
  describe("ListCatalogsHandler", () => {
    const handler = new ListCatalogsHandler();

    describe("handle()", () => {
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
          const clientManager = getMockedClientManager();
          // executeFlinkSql does POST (submit) → GET (poll status) → GET (results)
          const flinkRest = clientManager.getConfluentCloudFlinkRestClient();
          flinkRest.POST.mockResolvedValue({ data: SQL_RESPONSE });
          flinkRest.GET.mockResolvedValue({ data: SQL_RESPONSE });
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

      it("should embed config environment_id as catalog name in the POST SQL statement", async () => {
        const clientManager = getMockedClientManager();
        const flinkRest = clientManager.getConfluentCloudFlinkRestClient();
        flinkRest.POST.mockResolvedValue({ data: SQL_RESPONSE });
        flinkRest.GET.mockResolvedValue({ data: SQL_RESPONSE });

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
