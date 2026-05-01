import { ListFlinkStatementsHandler } from "@src/confluent/tools/handlers/flink/list-flink-statements-handler.js";
import { initEnv } from "@src/env.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  stubClientGetters,
  type HandleCase,
} from "@tests/stubs/index.js";
import { beforeAll, describe, it } from "vitest";

const FLINK_CONN = {
  flink: {
    endpoint: "https://flink.example.com",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
    environment_id: "env-from-config",
    organization_id: "org-from-config",
    compute_pool_id: "lfcp-from-config",
  },
};

const EXPLICIT_IDS = {
  organizationId: "org-from-args",
  environmentId: "env-from-args",
};

describe("list-flink-statements-handler.ts", () => {
  describe("ListFlinkStatementsHandler", () => {
    const handler = new ListFlinkStatementsHandler();

    // Required while the handler reads env vars via getEnsuredParam/Zod defaults.
    // Remove after issue #231 migrates those reads to conn.flink config fields.
    beforeAll(() => {
      initEnv();
    });

    describe("handle()", () => {
      const cases: HandleCase[] = [
        {
          label: "throws when organizationId is absent and not in env",
          args: {},
          outcome: { throws: "Organization ID is required" },
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
        async ({ args, outcome, responseData }) => {
          const { clientManager, clientGetters } =
            stubClientGetters(responseData);
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              FLINK_CONN,
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
