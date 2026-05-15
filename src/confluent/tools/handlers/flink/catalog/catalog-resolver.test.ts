import {
  resolveCatalogName,
  resolveDatabaseName,
} from "@src/confluent/tools/handlers/flink/catalog/catalog-resolver.js";
import { describe, expect, it } from "vitest";

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
});
