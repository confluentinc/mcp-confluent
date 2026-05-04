import { GetTableInfoHandler } from "@src/confluent/tools/handlers/flink/catalog/get-table-info-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  FLINK_CONN,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, it } from "vitest";

const TABLE_NAME = "my-table";

describe("get-table-info-handler.ts", () => {
  describe("GetTableInfoHandler", () => {
    const handler = new GetTableInfoHandler();

    describe("handle()", () => {
      const cases: HandleCaseWithConn[] = [
        {
          label: "throws ZodError when tableName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label: "throws when organizationId is absent and not in config",
          args: { tableName: TABLE_NAME },
          outcome: { throws: "Organization ID is required" },
          connectionConfig: {},
        },
        {
          label: "throws when environmentId is absent and not in config",
          args: { tableName: TABLE_NAME, organizationId: "org-from-args" },
          outcome: { throws: "Environment ID is required" },
          connectionConfig: {},
        },
        {
          label: "throws when computePoolId is absent and not in config",
          args: {
            tableName: TABLE_NAME,
            organizationId: "org-from-args",
            environmentId: "env-from-args",
          },
          outcome: { throws: "Compute Pool ID is required" },
          connectionConfig: {},
        },
        {
          label: "uses org/env/compute IDs from config when args absent",
          args: { tableName: TABLE_NAME },
          outcome: { resolves: `Table info for '${TABLE_NAME}'` },
          responseData: {
            status: { phase: "COMPLETED" },
            results: { data: [{ TABLE_NAME, TABLE_TYPE: "BASE TABLE" }] },
          },
        },
        {
          label: "uses explicit org/env/compute args over config",
          args: {
            tableName: TABLE_NAME,
            organizationId: "org-from-args",
            environmentId: "env-from-args",
            computePoolId: "lfcp-from-args",
          },
          outcome: { resolves: `Table info for '${TABLE_NAME}'` },
          responseData: {
            status: { phase: "COMPLETED" },
            results: { data: [{ TABLE_NAME, TABLE_TYPE: "BASE TABLE" }] },
          },
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
