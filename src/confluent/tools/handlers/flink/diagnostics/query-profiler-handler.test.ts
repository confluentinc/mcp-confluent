import { QueryProfilerHandler } from "@src/confluent/tools/handlers/flink/diagnostics/query-profiler-handler.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  flinkRuntime,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  stubClientGetters,
  type HandleCase,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const FLINK_CONN = {
  flink: {
    endpoint: "https://flink.example.com",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
    environment_id: "env-from-config",
    organization_id: "org-from-config",
    compute_pool_id: "lfcp-from-config",
  },
};

const STATEMENT_NAME = "my-statement";

type HandleCaseWithConn = HandleCase & {
  connectionConfig?: Parameters<typeof runtimeWith>[0];
};

describe("query-profiler-handler.ts", () => {
  describe("QueryProfilerHandler", () => {
    const handler = new QueryProfilerHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with both flink and telemetry blocks", () => {
        const runtime = runtimeWith({
          flink: {
            endpoint: "https://flink.us-east-1.aws.confluent.cloud",
            auth: { type: "api_key", key: "k", secret: "s" },
            environment_id: "env-abc123",
            organization_id: "org-xyz789",
            compute_pool_id: "lfcp-pool01",
          },
          telemetry: {
            endpoint: "https://api.telemetry.confluent.cloud",
            auth: { type: "api_key", key: "k", secret: "s" },
          },
        });
        expect(handler.enabledConnectionIds(runtime)).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection with flink but no telemetry block", () => {
        expect(handler.enabledConnectionIds(flinkRuntime())).toEqual([]);
      });

      it("should return an empty array for a connection without a flink block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });
    });

    describe("handle()", () => {
      const cases: HandleCaseWithConn[] = [
        {
          label: "throws ZodError when statementName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label: "throws when organizationId is absent and not in config",
          args: { statementName: STATEMENT_NAME },
          outcome: { throws: "Organization ID is required" },
          connectionConfig: {},
        },
        {
          label: "throws when environmentId is absent and not in config",
          args: {
            statementName: STATEMENT_NAME,
            organizationId: "org-from-args",
          },
          outcome: { throws: "Environment ID is required" },
          connectionConfig: {},
        },
        {
          label: "throws when computePoolId is absent and not in config",
          args: {
            statementName: STATEMENT_NAME,
            organizationId: "org-from-args",
            environmentId: "env-from-args",
          },
          outcome: { throws: "Compute Pool ID is required" },
          connectionConfig: {},
        },
        {
          label: "uses org/env/compute IDs from config when args absent",
          args: { statementName: STATEMENT_NAME },
          responseData: { Graph: '{"tasks":[]}' },
          outcome: { resolves: `Query Profiler for '${STATEMENT_NAME}'` },
        },
        {
          label: "uses explicit org/env/compute args over config",
          args: {
            statementName: STATEMENT_NAME,
            organizationId: "org-from-args",
            environmentId: "env-from-args",
            computePoolId: "lfcp-from-args",
          },
          responseData: { Graph: '{"tasks":[]}' },
          outcome: { resolves: `Query Profiler for '${STATEMENT_NAME}'` },
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
