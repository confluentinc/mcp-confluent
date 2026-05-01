import { CreateFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/create-flink-statement-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  stubClientGetters,
  type HandleCase,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

const FLINK_CONN = {
  flink: {
    endpoint: "https://flink.example.com",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
    environment_id: "env-from-config",
    organization_id: "org-from-config",
    compute_pool_id: "lfcp-from-config",
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

type HandleCaseWithConn = HandleCase & {
  connectionConfig?: Parameters<typeof runtimeWith>[0];
};

describe("create-flink-statement-handler.ts", () => {
  describe("CreateFlinkStatementHandler", () => {
    const handler = new CreateFlinkStatementHandler();

    describe("handle()", () => {
      const cases: HandleCaseWithConn[] = [
        {
          label: "throws ZodError when statement is absent",
          args: { statementName: "my-statement" },
          outcome: { throws: "ZodError" },
        },
        {
          label: "throws ZodError when statementName is absent",
          args: { statement: "SELECT 1" },
          outcome: { throws: "ZodError" },
        },
        {
          label: "throws when organizationId is absent and not in config",
          args: REQUIRED_ARGS,
          outcome: { throws: "Organization ID is required" },
          connectionConfig: {},
        },
        {
          label: "throws when environmentId is absent and not in config",
          args: { ...REQUIRED_ARGS, organizationId: "org-from-args" },
          outcome: { throws: "Environment ID is required" },
          connectionConfig: {},
        },
        {
          label: "throws when computePoolId is absent and not in config",
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
            "uses org/env/computePool IDs and catalog/database names from config when args absent",
          args: REQUIRED_ARGS,
          outcome: { resolves: "{}" },
        },
        {
          label:
            "omits catalog and database from request when absent from both args and config",
          args: { ...REQUIRED_ARGS, ...EXPLICIT_IDS },
          outcome: { resolves: "{}" },
          connectionConfig: FLINK_CONN_NO_NAMES,
        },
        {
          label: "explicit args take precedence over config values",
          args: {
            ...REQUIRED_ARGS,
            ...EXPLICIT_IDS,
            catalogName: "catalog-from-args",
            databaseName: "db-from-args",
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
    });
  });
});
