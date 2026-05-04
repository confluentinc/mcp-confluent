import { QueryProfilerHandler } from "@src/confluent/tools/handlers/flink/diagnostics/query-profiler-handler.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  FLINK_CONN,
  flinkRuntime,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const STATEMENT_NAME = "my-statement";

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
