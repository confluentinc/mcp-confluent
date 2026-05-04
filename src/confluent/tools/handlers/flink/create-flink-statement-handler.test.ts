// NOTE FOR ISSUE #231 MIGRATION
//
// This test file was created alongside the #308 "capturedCalls" infrastructure
// to provide a concrete demonstration of POST-body assertion.
//
// The handler under test currently resolves org/env/pool IDs via getEnsuredParam()
// reading from env vars (FLINK_ORG_ID, FLINK_ENV_ID, FLINK_COMPUTE_POOL_ID), and
// catalogName/databaseName from Zod defaults backed by FLINK_ENV_NAME /
// FLINK_DATABASE_NAME. Because those env vars are not set in unit tests, all
// required values are supplied here as explicit tool arguments. The env proxy
// throws "Environment not initialized" when accessed before initEnv(), so the
// "throws when X absent and not in env" cases are not testable here and are
// intentionally omitted — they belong in the 231 migration.
//
// When issue #231 migrates this handler to read org/env/pool from conn.flink.*
// (via resolveOrgAndEnvIds / resolveComputePoolId) and catalogName/databaseName
// from the catalog-resolver helpers:
//
//   1. Replace the explicit org/env/pool args with connectionConfig: FLINK_CONN
//      so the config-fallback path is exercised.
//   2. Add throw cases for each required ID absent from both args and config
//      (connectionConfig: {}, args: {}).
//   3. Add the three catalogName/databaseName property-spreading cases from the
//      issue spec:
//        a. explicit catalogName/databaseName args → both keys in spec.properties
//        b. absent from args, present in config    → both keys from config values
//        c. absent from both args and config       → spec.properties is {}
//   4. The capturedCalls assertions below remain valid but fixture shapes will
//      change to match the migrated handler's POST body structure.

import { CreateFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/create-flink-statement-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

// Minimal args that satisfy every required field without relying on env vars.
const BASE_ARGS = {
  organizationId: "org-from-args",
  environmentId: "env-from-args",
  computePoolId: "lfcp-from-args",
  statement: "SELECT 1",
  statementName: "test-stmt",
  catalogName: "my-catalog",
  databaseName: "my-database",
};

describe("create-flink-statement-handler.ts", () => {
  describe("CreateFlinkStatementHandler", () => {
    const handler = new CreateFlinkStatementHandler();

    describe("handle()", () => {
      it("should resolve when all required args are supplied explicitly", async () => {
        const { clientManager, clientGetters } = stubClientGetters({});
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: BASE_ARGS,
          outcome: { resolves: "{}" },
          clientGetters,
        });
      });

      it("should include catalogName and databaseName in POST spec.properties", async () => {
        const { clientManager, clientGetters, capturedCalls } =
          stubClientGetters({});
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: BASE_ARGS,
          outcome: { resolves: "{}" },
          clientGetters,
        });
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]!.args).toMatchObject({
          body: expect.objectContaining({
            spec: expect.objectContaining({
              properties: {
                "sql.current-catalog": "my-catalog",
                "sql.current-database": "my-database",
              },
            }),
          }),
        });
      });
    });
  });
});
