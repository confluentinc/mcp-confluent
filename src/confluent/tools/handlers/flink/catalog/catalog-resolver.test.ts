import {
  resolveCatalogName,
  resolveDatabaseName,
} from "@src/confluent/tools/handlers/flink/catalog/catalog-resolver.js";
import { describe, expect, it } from "vitest";

const CONN_WITH_FLINK_AND_KAFKA = {
  type: "direct" as const,
  flink: {
    endpoint: "https://flink.example.com",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
    environment_id: "env-abc123",
    organization_id: "org-xyz",
    compute_pool_id: "lfcp-pool01",
  },
  kafka: {
    bootstrap_servers: "broker:9092",
    cluster_id: "lkc-from-config",
  },
};

describe("catalog-resolver.ts", () => {
  describe("resolveCatalogName()", () => {
    it("should return the input unchanged when it looks like an env ID", () => {
      expect(resolveCatalogName("env-abc123", CONN_WITH_FLINK_AND_KAFKA)).toBe(
        "env-abc123",
      );
    });

    it("should fall back to conn.flink.environment_id when input is a friendly name", () => {
      expect(
        resolveCatalogName("my-friendly-env", CONN_WITH_FLINK_AND_KAFKA),
      ).toBe("env-abc123");
    });

    it("should fall back to conn.flink.environment_id when input is absent", () => {
      expect(resolveCatalogName(undefined, CONN_WITH_FLINK_AND_KAFKA)).toBe(
        "env-abc123",
      );
    });

    it("should return undefined when input is absent and conn has no flink block", () => {
      expect(
        resolveCatalogName(undefined, { type: "direct" as const }),
      ).toBeUndefined();
    });
  });

  describe("resolveDatabaseName()", () => {
    it("should return the input unchanged when it is a non-empty value", () => {
      expect(
        resolveDatabaseName("lkc-explicit", CONN_WITH_FLINK_AND_KAFKA),
      ).toBe("lkc-explicit");
    });

    it("should fall back to conn.kafka.cluster_id when input is absent", () => {
      expect(resolveDatabaseName(undefined, CONN_WITH_FLINK_AND_KAFKA)).toBe(
        "lkc-from-config",
      );
    });

    it("should return undefined when input is absent and conn has no kafka block", () => {
      expect(
        resolveDatabaseName(undefined, { type: "direct" as const }),
      ).toBeUndefined();
    });
  });
});
