import { CreateFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/create-flink-statement-handler.js";
import {
  FLINK_CONN as BASE_FLINK_CONN,
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const FLINK_CONN = {
  flink: {
    ...BASE_FLINK_CONN.flink,
    environment_name: "env-name-from-config",
    database_name: "db-name-from-config",
  },
};

// Flink config without the optional environment_name / database_name fields,
// used to exercise the ?? "" fallback in resolvedCatalogName / resolvedDatabaseName.
const FLINK_CONN_NO_NAMES = {
  flink: {
    endpoint: "https://flink.example.com",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
    environment_id: "env-from-config",
    organization_id: "org-from-config",
    compute_pool_id: "lfcp-from-config",
  },
};

const REQUIRED_ARGS = {
  statement: "SELECT 1",
  statementName: "my-statement",
};

const EXPLICIT_IDS = {
  organizationId: "org-from-args",
  environmentId: "env-from-args",
  computePoolId: "lfcp-from-args",
};

describe("create-flink-statement-handler.ts", () => {
  describe("CreateFlinkStatementHandler", () => {
    const handler = new CreateFlinkStatementHandler();

    describe("handle()", () => {
      const cases: HandleCaseWithConn[] = [
        {
          label: "throw ZodError when statement is absent",
          args: { statementName: "my-statement" },
          outcome: { throws: "ZodError" },
        },
        {
          label: "throw ZodError when statementName is absent",
          args: { statement: "SELECT 1" },
          outcome: { throws: "ZodError" },
        },
        {
          label: "throw when organizationId is absent and not in config",
          args: REQUIRED_ARGS,
          outcome: { throws: "Organization ID is required" },
          connectionConfig: {},
        },
        {
          label: "throw when environmentId is absent and not in config",
          args: { ...REQUIRED_ARGS, organizationId: "org-from-args" },
          outcome: { throws: "Environment ID is required" },
          connectionConfig: {},
        },
        {
          label: "throw when computePoolId is absent and not in config",
          args: {
            ...REQUIRED_ARGS,
            organizationId: "org-from-args",
            environmentId: "env-from-args",
          },
          outcome: { throws: "Compute Pool ID is required" },
          connectionConfig: {},
        },
        {
          label:
            "use org/env/computePool IDs and catalog/database names from config when args absent",
          args: REQUIRED_ARGS,
          outcome: { resolves: "{}" },
        },
        {
          label:
            "omit catalog and database from request when absent from both args and config",
          args: { ...REQUIRED_ARGS, ...EXPLICIT_IDS },
          outcome: { resolves: "{}" },
          connectionConfig: FLINK_CONN_NO_NAMES,
        },
        {
          label: "prefer explicit args over config values",
          args: {
            ...REQUIRED_ARGS,
            ...EXPLICIT_IDS,
            catalogName: "catalog-from-args",
            databaseName: "db-from-args",
          },
          outcome: { resolves: "{}" },
        },
        {
          // Regression: blank strings must fall back to config, not silently omit the
          // sql.current-catalog / sql.current-database properties. The Zod schema trims
          // whitespace, so "  " becomes "". Using || (not ??) ensures "" is treated as
          // absent and the connection config value is used instead.
          label:
            "fall back to config when catalogName/databaseName args are blank",
          args: {
            ...REQUIRED_ARGS,
            ...EXPLICIT_IDS,
            catalogName: "   ",
            databaseName: "   ",
          },
          outcome: { resolves: "{}" },
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

      it("should include catalog/database names from config in POST spec.properties when absent from args", async () => {
        const { clientManager, clientGetters, capturedCalls } =
          stubClientGetters({});
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: REQUIRED_ARGS,
          outcome: { resolves: "{}" },
          clientGetters,
        });
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]!.args).toMatchObject({
          body: expect.objectContaining({
            spec: expect.objectContaining({
              properties: {
                "sql.current-catalog": FLINK_CONN.flink.environment_name,
                "sql.current-database": FLINK_CONN.flink.database_name,
              },
            }),
          }),
        });
      });

      it("should omit catalog/database keys from POST spec.properties when absent from both args and config", async () => {
        const { clientManager, clientGetters, capturedCalls } =
          stubClientGetters({});
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN_NO_NAMES,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { ...REQUIRED_ARGS, ...EXPLICIT_IDS },
          outcome: { resolves: "{}" },
          clientGetters,
        });
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]!.args).toMatchObject({
          body: expect.objectContaining({
            spec: expect.objectContaining({
              properties: {},
            }),
          }),
        });
      });

      it("should use explicit catalogName/databaseName args over config values in POST spec.properties", async () => {
        const { clientManager, clientGetters, capturedCalls } =
          stubClientGetters({});
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            ...REQUIRED_ARGS,
            ...EXPLICIT_IDS,
            catalogName: "catalog-from-args",
            databaseName: "db-from-args",
          },
          outcome: { resolves: "{}" },
          clientGetters,
        });
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]!.args).toMatchObject({
          body: expect.objectContaining({
            spec: expect.objectContaining({
              properties: {
                "sql.current-catalog": "catalog-from-args",
                "sql.current-database": "db-from-args",
              },
            }),
          }),
        });
      });

      it("should fall back to config catalog/database in POST spec.properties when args are blank", async () => {
        const { clientManager, clientGetters, capturedCalls } =
          stubClientGetters({});
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            ...REQUIRED_ARGS,
            ...EXPLICIT_IDS,
            catalogName: "   ",
            databaseName: "   ",
          },
          outcome: { resolves: "{}" },
          clientGetters,
        });
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]!.args).toMatchObject({
          body: expect.objectContaining({
            spec: expect.objectContaining({
              properties: {
                "sql.current-catalog": FLINK_CONN.flink.environment_name,
                "sql.current-database": FLINK_CONN.flink.database_name,
              },
            }),
          }),
        });
      });
    });
  });
});
