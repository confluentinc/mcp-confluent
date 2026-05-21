import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { CheckHealthHandler } from "@src/confluent/tools/handlers/flink/diagnostics/check-health-handler.js";
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
import { describe, expect, it } from "vitest";

const EXPLICIT_IDS = {
  organizationId: "org-from-args",
  environmentId: "env-from-args",
};

const STATEMENT_NAME = "my-statement";

describe("check-health-handler.ts", () => {
  describe("CheckHealthHandler", () => {
    const handler = new CheckHealthHandler();

    describe("getToolConfig()", () => {
      it("should describe the check-flink-statement-health tool as read-only", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe("check-flink-statement-health");
        expect(config.description).toContain("health check");
        expect(config.inputSchema).toHaveProperty("statementName");
        expect(config.annotations).toBe(READ_ONLY);
      });
    });

    describe("handle()", () => {
      const cases: FlinkGetCase[] = [
        {
          label: "throws ZodError when statementName is absent",
          args: {},
          outcome: { throws: "ZodError" },
          connectionConfig: {},
        },
        {
          label:
            "uses org/env IDs from config and reports healthy for running statement",
          args: { statementName: STATEMENT_NAME },
          flinkGetData: { status: { phase: "RUNNING" }, data: [] },
          outcome: { resolves: `Health check for '${STATEMENT_NAME}'` },
        },
        {
          label: "uses explicit org/env args over config",
          args: { statementName: STATEMENT_NAME, ...EXPLICIT_IDS },
          flinkGetData: { status: { phase: "RUNNING" }, data: [] },
          outcome: { resolves: `Health check for '${STATEMENT_NAME}'` },
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
            clientManager
              .getConfluentCloudFlinkRestClient()
              .GET.mockResolvedValue({ data: flinkGetData });
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

      // Phase → status mapping cases. The statement GET resolves with the
      // given status; the exceptions GET resolves with an empty list (no
      // exception-related branches involved here).
      it.each([
        { phase: "COMPLETED", expected: '"status": "healthy"' },
        { phase: "FAILED", expected: '"status": "critical"' },
        { phase: "FAILING", expected: '"status": "critical"' },
        { phase: "STOPPED", expected: '"status": "warning"' },
        { phase: "PENDING", expected: '"status": "warning"' },
        { phase: "SOME_NEW_STATE", expected: '"status": "unknown"' },
      ])(
        "should map phase $phase to expected status",
        async ({ phase, expected }) => {
          const clientManager = getMockedClientManager();
          const flinkRest = clientManager.getConfluentCloudFlinkRestClient();
          flinkRest.GET.mockResolvedValueOnce({
            data: { status: { phase }, spec: { statement: "SELECT 1" } },
          }).mockResolvedValueOnce({ data: { data: [] } });
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              FLINK_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args: { statementName: STATEMENT_NAME },
            outcome: { resolves: expected },
            clientManager,
          });
        },
      );

      it("should report warning when running statement has exceptions", async () => {
        const clientManager = getMockedClientManager();
        const flinkRest = clientManager.getConfluentCloudFlinkRestClient();
        flinkRest.GET.mockResolvedValueOnce({
          data: { status: { phase: "RUNNING" } },
        }).mockResolvedValueOnce({
          data: { data: [{ message: "kaboom" }, { message: "earlier" }] },
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: "2 recent exception(s)" },
          clientManager,
        });
      });

      it("should include status.detail in FAILED message when present", async () => {
        const clientManager = getMockedClientManager();
        const flinkRest = clientManager.getConfluentCloudFlinkRestClient();
        flinkRest.GET.mockResolvedValueOnce({
          data: { status: { phase: "FAILED", detail: "ran out of memory" } },
        }).mockResolvedValueOnce({ data: { data: [] } });
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: "ran out of memory" },
          clientManager,
        });
      });

      it("should fall back to latest exception message when FAILING and no detail", async () => {
        const clientManager = getMockedClientManager();
        const flinkRest = clientManager.getConfluentCloudFlinkRestClient();
        flinkRest.GET.mockResolvedValueOnce({
          data: { status: { phase: "FAILING" } },
        }).mockResolvedValueOnce({
          data: { data: [{ message: "downstream timeout" }] },
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: { resolves: "downstream timeout" },
          clientManager,
        });
      });

      it("should return an error response when the status GET errors", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudFlinkRestClient()
          .GET.mockResolvedValueOnce({ error: { code: 500, message: "boom" } });
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            FLINK_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { statementName: STATEMENT_NAME },
          outcome: {
            resolves: "Failed to get statement status",
            isError: true,
          },
          clientManager,
        });
      });
    });
  });
});
