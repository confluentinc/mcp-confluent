import { ListFlinkStatementsHandler } from "@src/confluent/tools/handlers/flink/list-flink-statements-handler.js";
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

const EXPLICIT_IDS = {
  organizationId: "org-from-args",
  environmentId: "env-from-args",
};

type ListStatementsCase = HandleCaseWithConn & {
  /** Body returned by the Flink REST GET. */
  flinkGetData: unknown;
};

describe("list-flink-statements-handler.ts", () => {
  describe("ListFlinkStatementsHandler", () => {
    const handler = new ListFlinkStatementsHandler();

    describe("handle()", () => {
      const cases: ListStatementsCase[] = [
        {
          label:
            "use org/env IDs and computePoolId from config when args absent",
          args: {},
          flinkGetData: {},
          outcome: { resolves: "{}" },
        },
        {
          label: "resolve when required IDs are supplied as explicit args",
          args: EXPLICIT_IDS,
          flinkGetData: {},
          outcome: { resolves: "{}" },
        },
        {
          label: "filter statements client-side by statusPhase",
          args: { ...EXPLICIT_IDS, statusPhase: "RUNNING" },
          flinkGetData: {
            data: [
              { status: { phase: "RUNNING" } },
              { status: { phase: "FAILED" } },
            ],
          },
          outcome: { resolves: "Found 1 statement(s) with status 'RUNNING'" },
        },
        {
          label:
            "report zero results when no statements match the statusPhase filter",
          args: { ...EXPLICIT_IDS, statusPhase: "RUNNING" },
          flinkGetData: { data: [{ status: { phase: "FAILED" } }] },
          outcome: { resolves: "Found 0 statement(s) with status 'RUNNING'" },
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
          clientManager
            .getConfluentCloudFlinkRestClient()
            .GET.mockResolvedValue({ data: flinkGetData });
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

      it("should fall back to config computePoolId when arg is whitespace-only", async () => {
        const clientManager = getMockedClientManager();
        const flinkRest = clientManager.getConfluentCloudFlinkRestClient();
        flinkRest.GET.mockResolvedValue({ data: {} });

        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { ...EXPLICIT_IDS, computePoolId: "   " },
          outcome: { resolves: "{}" },
          clientManager,
        });

        expect(flinkRest.GET).toHaveBeenCalledOnce();
        expect(flinkRest.GET).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            params: expect.objectContaining({
              query: expect.objectContaining({
                "spec.compute_pool_id": FLINK_CONN.flink.compute_pool_id,
              }),
            }),
          }),
        );
      });
    });
  });
});
