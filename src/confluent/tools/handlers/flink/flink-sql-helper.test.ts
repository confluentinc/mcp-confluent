import { executeFlinkSql } from "@src/confluent/tools/handlers/flink/flink-sql-helper.js";
import {
  getMockedClientManager,
  type MockedClientManager,
  type MockedRestClient,
} from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const STATEMENTS_PATH =
  "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements";
const STATEMENT_PATH = `${STATEMENTS_PATH}/{statement_name}`;

const COMPLETED_RESPONSE = {
  status: { phase: "COMPLETED" },
  results: { data: [{ CATALOG_NAME: "env-123" }] },
};

const OPTIONS = {
  organizationId: "org-1",
  environmentId: "env-123",
  computePoolId: "lfcp-1",
};

describe("flink-sql-helper.ts", () => {
  describe("executeFlinkSql", () => {
    let clientManager: MockedClientManager;
    let flinkRest: MockedRestClient;

    beforeEach(() => {
      clientManager = getMockedClientManager();
      flinkRest = clientManager.getConfluentCloudFlinkRestClient();
      flinkRest.POST.mockResolvedValue({ data: COMPLETED_RESPONSE });
      flinkRest.GET.mockResolvedValue({ data: COMPLETED_RESPONSE });
      flinkRest.DELETE.mockResolvedValue({ data: {} });
    });

    it("should submit internal queries in snapshot mode", async () => {
      await executeFlinkSql(clientManager, "SELECT 1", OPTIONS);

      expect(flinkRest.POST).toHaveBeenCalledWith(
        STATEMENTS_PATH,
        expect.objectContaining({
          body: expect.objectContaining({
            spec: expect.objectContaining({
              properties: expect.objectContaining({
                "sql.snapshot.mode": "now",
              }),
            }),
          }),
        }),
      );
    });

    it("should mark internal queries hidden via the well-known label", async () => {
      await executeFlinkSql(clientManager, "SELECT 1", OPTIONS);

      expect(flinkRest.POST).toHaveBeenCalledWith(
        STATEMENTS_PATH,
        expect.objectContaining({
          body: expect.objectContaining({
            metadata: { labels: { "user.confluent.io/hidden": "true" } },
          }),
        }),
      );
    });

    it("should delete the statement after a bounded query completes", async () => {
      const result = await executeFlinkSql(clientManager, "SELECT 1", OPTIONS);

      expect(result.success).toBe(true);
      expect(flinkRest.DELETE).toHaveBeenCalledOnce();
      expect(flinkRest.DELETE).toHaveBeenCalledWith(STATEMENT_PATH, {
        params: {
          path: {
            organization_id: "org-1",
            environment_id: "env-123",
            statement_name: result.statementName,
          },
        },
      });
    });

    it("should keep the result successful when cleanup DELETE rejects", async () => {
      flinkRest.DELETE.mockRejectedValue(new Error("boom"));

      const result = await executeFlinkSql(clientManager, "SELECT 1", OPTIONS);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([{ CATALOG_NAME: "env-123" }]);
    });

    it("should keep the result successful when cleanup DELETE returns an error envelope", async () => {
      flinkRest.DELETE.mockResolvedValue({ error: { message: "nope" } });

      const result = await executeFlinkSql(clientManager, "SELECT 1", OPTIONS);

      expect(result.success).toBe(true);
      expect(result.data).toEqual([{ CATALOG_NAME: "env-123" }]);
    });
  });
});
