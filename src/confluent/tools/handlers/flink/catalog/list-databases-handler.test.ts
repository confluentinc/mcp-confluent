import { ListDatabasesHandler } from "@src/confluent/tools/handlers/flink/catalog/list-databases-handler.js";
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
  results: { data: [{ SCHEMA_ID: "1", SCHEMA_NAME: "my-cluster" }] },
};

describe("list-databases-handler.ts", () => {
  describe("ListDatabasesHandler", () => {
    const handler = new ListDatabasesHandler();

    describe("handle()", () => {
      const cases: HandleCaseWithConn[] = [
        {
          label: "throws when organizationId is absent and not in config",
          args: {},
          outcome: { throws: "Organization ID is required" },
          connectionConfig: {},
        },
        {
          label: "throws when environmentId is absent and not in config",
          args: { organizationId: "org-from-args" },
          outcome: { throws: "Environment ID is required" },
          connectionConfig: {},
        },
        {
          label: "throws when computePoolId is absent and not in config",
          args: {
            organizationId: "org-from-args",
            environmentId: "env-from-args",
          },
          outcome: { throws: "Compute Pool ID is required" },
          connectionConfig: {},
        },
        {
          label: "uses org/env/compute IDs from config when args absent",
          args: {},
          outcome: { resolves: "Databases" },
          responseData: SQL_RESPONSE,
        },
        {
          label: "uses explicit org/env/compute args over config",
          args: {
            organizationId: "org-from-args",
            environmentId: "env-from-args",
            computePoolId: "lfcp-from-args",
          },
          outcome: { resolves: "Databases" },
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

      it("should embed config environment_id as catalog name in the POST SQL statement", async () => {
        const { clientManager, clientGetters, capturedCalls } =
          stubClientGetters(SQL_RESPONSE);
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: { resolves: "Databases" },
          clientGetters,
        });
        expect(capturedCalls).toHaveLength(3);
        expect(capturedCalls[0]!.args).toMatchObject({
          body: expect.objectContaining({
            spec: expect.objectContaining({
              statement: expect.stringContaining(
                FLINK_CONN.flink.environment_id,
              ),
            }),
          }),
        });
      });
    });
  });
});
