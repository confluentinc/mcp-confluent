import { ListFlinkStatementsHandler } from "@src/confluent/tools/handlers/flink/list-flink-statements-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  FLINK_CONN,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const EXPLICIT_IDS = {
  organizationId: "org-from-args",
  environmentId: "env-from-args",
};

describe("list-flink-statements-handler.ts", () => {
  describe("ListFlinkStatementsHandler", () => {
    const handler = new ListFlinkStatementsHandler();

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
          label:
            "uses org/env IDs and computePoolId from config when args absent",
          args: {},
          outcome: { resolves: "{}" },
        },
        {
          label: "resolves when required IDs are supplied as explicit args",
          args: EXPLICIT_IDS,
          outcome: { resolves: "{}" },
        },
        {
          label: "filters statements client-side by statusPhase",
          args: {
            ...EXPLICIT_IDS,
            statusPhase: "RUNNING",
          },
          responseData: {
            data: [
              { status: { phase: "RUNNING" } },
              { status: { phase: "FAILED" } },
            ],
          },
          outcome: { resolves: "Found 1 statement(s) with status 'RUNNING'" },
        },
        {
          label:
            "reports zero results when no statements match the statusPhase filter",
          args: {
            ...EXPLICIT_IDS,
            statusPhase: "RUNNING",
          },
          responseData: {
            data: [{ status: { phase: "FAILED" } }],
          },
          outcome: { resolves: "Found 0 statement(s) with status 'RUNNING'" },
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

      it("should fall back to config computePoolId when arg is whitespace-only", async () => {
        const { clientManager, clientGetters, capturedCalls } =
          stubClientGetters({});
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { ...EXPLICIT_IDS, computePoolId: "   " },
          outcome: { resolves: "{}" },
          clientGetters,
        });
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]!.args).toMatchObject({
          params: expect.objectContaining({
            query: expect.objectContaining({
              "spec.compute_pool_id": FLINK_CONN.flink.compute_pool_id,
            }),
          }),
        });
      });
    });
  });
});
