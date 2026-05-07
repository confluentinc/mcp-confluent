import { QueryProfilerHandler } from "@src/confluent/tools/handlers/flink/diagnostics/query-profiler-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  FLINK_CONN,
  FlinkGetCase,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

const STATEMENT_NAME = "my-statement";

describe("query-profiler-handler.ts", () => {
  describe("QueryProfilerHandler", () => {
    const handler = new QueryProfilerHandler();

    describe("handle()", () => {
      const cases: FlinkGetCase[] = [
        {
          label: "throws ZodError when statementName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label: "uses org/env/compute IDs from config when args absent",
          args: { statementName: STATEMENT_NAME },
          flinkGetData: { Graph: '{"tasks":[]}' },
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
          flinkGetData: { Graph: '{"tasks":[]}' },
          outcome: { resolves: `Query Profiler for '${STATEMENT_NAME}'` },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({
          args,
          outcome,
          flinkGetData,
          connectionConfig = FLINK_CONN,
        }) => {
          const clientManager = getMockedClientManager();
          if (flinkGetData !== undefined) {
            // handler GETs the statement graph from Flink REST and POSTs telemetry
            // queries afterwards; both clients need a usable response
            clientManager
              .getConfluentCloudFlinkRestClient()
              .GET.mockResolvedValue({ data: flinkGetData });
            clientManager
              .getConfluentCloudTelemetryRestClient()
              .POST.mockResolvedValue({ data: { data: [] } });
          }
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
    });
  });
});
