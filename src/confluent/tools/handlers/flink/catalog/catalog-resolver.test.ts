import {
  getSchemaMapping,
  resolveCatalogName,
  resolveDatabaseName,
  resolveToCatalogName,
  resolveToSchemaName,
} from "@src/confluent/tools/handlers/flink/catalog/catalog-resolver.js";
import {
  getMockedClientManager,
  type MockedClientManager,
  type MockedRestClient,
} from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

const SQL_OPTIONS = {
  organizationId: "org-1",
  environmentId: "env-abc123",
  computePoolId: "lfcp-1",
};

/**
 * Builds the `{ status, results }` envelope that `executeFlinkSql` polls for,
 * so a resolver lookup sees `rows` as its result data.
 */
function sqlResponse(rows: unknown[]) {
  return {
    status: { phase: "COMPLETED" },
    results: { data: rows },
  };
}

describe("catalog-resolver.ts", () => {
  describe("resolveCatalogName()", () => {
    it("should return the input unchanged when it looks like an env ID", () => {
      expect(resolveCatalogName("env-abc123", "env-abc123")).toBe("env-abc123");
    });

    it("should fall back to fallbackEnvId when input is a friendly name", () => {
      expect(resolveCatalogName("my-friendly-env", "env-abc123")).toBe(
        "env-abc123",
      );
    });

    it("should use fallbackEnvId when input is absent", () => {
      expect(resolveCatalogName(undefined, "env-abc123")).toBe("env-abc123");
    });

    it("should return undefined when input is absent and fallbackEnvId is absent", () => {
      expect(resolveCatalogName()).toBeUndefined();
    });

    it("should return undefined when fallbackEnvId is a friendly name, not an env ID", () => {
      expect(resolveCatalogName(undefined, "production")).toBeUndefined();
    });

    it("should return undefined when both catalogName and fallbackEnvId are friendly names", () => {
      expect(resolveCatalogName("my-catalog", "production")).toBeUndefined();
    });
  });

  describe("resolveDatabaseName()", () => {
    const CONN_WITH_KAFKA = {
      type: "direct" as const,
      kafka: {
        bootstrap_servers: "broker:9092",
        cluster_id: "lkc-from-config",
      },
    };

    it("should return the input unchanged when it is a non-empty value", () => {
      expect(resolveDatabaseName("lkc-explicit", CONN_WITH_KAFKA)).toBe(
        "lkc-explicit",
      );
    });

    it("should fall back to conn.kafka.cluster_id when input is absent", () => {
      expect(resolveDatabaseName(undefined, CONN_WITH_KAFKA)).toBe(
        "lkc-from-config",
      );
    });

    it("should return undefined when input is absent and conn has no kafka block", () => {
      expect(
        resolveDatabaseName(undefined, { type: "direct" as const }),
      ).toBeUndefined();
    });

    it("should fall back to conn.kafka.cluster_id when input is whitespace-only", () => {
      expect(resolveDatabaseName("   ", CONN_WITH_KAFKA)).toBe(
        "lkc-from-config",
      );
    });

    it("should trim a whitespace-padded conn.kafka.cluster_id", () => {
      const conn = {
        type: "direct" as const,
        kafka: {
          bootstrap_servers: "broker:9092",
          cluster_id: "  lkc-padded  ",
        },
      };
      expect(resolveDatabaseName(undefined, conn)).toBe("lkc-padded");
    });

    it("should return undefined when input is absent and conn.kafka.cluster_id is whitespace-only", () => {
      const conn = {
        type: "direct" as const,
        kafka: { bootstrap_servers: "broker:9092", cluster_id: "   " },
      };
      expect(resolveDatabaseName(undefined, conn)).toBeUndefined();
    });
  });

  describe("resolveToCatalogName()", () => {
    const mappings = [
      { catalogId: "env-abc123", catalogName: "production" },
      { catalogId: "env-def456", catalogName: "staging" },
    ];

    it("should map an env ID to its friendly CATALOG_NAME", () => {
      expect(resolveToCatalogName("env-abc123", mappings)).toBe("production");
    });

    it("should return the env ID unchanged when no mapping matches", () => {
      expect(resolveToCatalogName("env-unknown", mappings)).toBe("env-unknown");
    });

    it("should pass a friendly name through unchanged", () => {
      expect(resolveToCatalogName("production", mappings)).toBe("production");
    });
  });

  describe("resolveToSchemaName()", () => {
    const mappings = [
      { schemaId: "lkc-abc123", schemaName: "orders_cluster" },
      { schemaId: "lkc-def456", schemaName: "events_cluster" },
    ];

    it("should map a cluster ID to its friendly SCHEMA_NAME", () => {
      expect(resolveToSchemaName("lkc-abc123", mappings)).toBe(
        "orders_cluster",
      );
    });

    it("should return the cluster ID unchanged when no mapping matches", () => {
      expect(resolveToSchemaName("lkc-unknown", mappings)).toBe("lkc-unknown");
    });

    it("should pass a friendly name through unchanged", () => {
      expect(resolveToSchemaName("orders_cluster", mappings)).toBe(
        "orders_cluster",
      );
    });
  });

  describe("getSchemaMapping()", () => {
    let clientManager: MockedClientManager;
    let flinkRest: MockedRestClient;

    beforeEach(() => {
      clientManager = getMockedClientManager();
      flinkRest = clientManager.getConfluentCloudFlinkRestClient();
    });

    it("should map SCHEMA_ID/SCHEMA_NAME rows from INFORMATION_SCHEMA.SCHEMATA", async () => {
      const rows = [
        { row: ["lkc-abc123", "orders_cluster"] },
        { row: ["lkc-def456", "events_cluster"] },
      ];
      flinkRest.POST.mockResolvedValue({ data: sqlResponse(rows) });
      flinkRest.GET.mockResolvedValue({ data: sqlResponse(rows) });

      const result = await getSchemaMapping(
        clientManager,
        "env-abc123",
        SQL_OPTIONS,
      );

      expect(result.mappings).toEqual([
        { schemaId: "lkc-abc123", schemaName: "orders_cluster" },
        { schemaId: "lkc-def456", schemaName: "events_cluster" },
      ]);
      expect(result.statementName).toMatch(/^mcp-query-/);
    });

    it("should drop rows whose SCHEMA_ID or SCHEMA_NAME is not a string", async () => {
      const rows = [
        { row: ["lkc-abc123", "orders_cluster"] },
        { row: [7, "numeric-id"] },
        { row: ["lkc-ghi789", undefined] },
      ];
      flinkRest.POST.mockResolvedValue({ data: sqlResponse(rows) });
      flinkRest.GET.mockResolvedValue({ data: sqlResponse(rows) });

      const result = await getSchemaMapping(
        clientManager,
        "env-abc123",
        SQL_OPTIONS,
      );

      expect(result.mappings).toEqual([
        { schemaId: "lkc-abc123", schemaName: "orders_cluster" },
      ]);
    });

    it("should return no mappings but still surface the statement name when the query fails", async () => {
      const failed = {
        status: { phase: "FAILED", detail: "synthetic failure" },
        results: { data: [] },
      };
      flinkRest.POST.mockResolvedValue({ data: failed });
      flinkRest.GET.mockResolvedValue({ data: failed });

      const result = await getSchemaMapping(
        clientManager,
        "env-abc123",
        SQL_OPTIONS,
      );

      expect(result.mappings).toEqual([]);
      expect(result.statementName).toMatch(/^mcp-query-/);
    });
  });
});
