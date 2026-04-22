import { MCPServerConfiguration, mcpConfigSchema } from "@src/config/models.js";
import { describe, expect, it } from "vitest";

describe("config/models.ts", () => {
  const validFlinkBlock = {
    endpoint: "https://flink.us-east-1.aws.confluent.cloud",
    auth: { type: "api_key" as const, key: "flinkkey", secret: "flinksecret" },
    environment_id: "env-abc123",
    organization_id: "org-xyz789",
    compute_pool_id: "lfcp-pool01",
  };

  const directConnection = {
    type: "direct" as const,
    kafka: { bootstrap_servers: "localhost:9092" },
  };
  describe("mcpConfigSchema", () => {
    it("should reject unknown keys at the document root", () => {
      const result = mcpConfigSchema.safeParse({
        conenctions: { local: directConnection },
      });

      expect(result.success).toBe(false);
    });

    // Add a new case here for each new sub-model block added to directConnectionSchema.
    it.each([
      [
        "confluent_cloud",
        { endpoint: "https://api.confluent.cloud", bogus: 1 },
      ],
      ["kafka", { bootstrap_servers: "broker:9092", bogus: 1 }],
      ["schema_registry", { endpoint: "https://sr.example.com", bogus: 1 }],
      [
        "tableflow",
        { auth: { type: "api_key", key: "k", secret: "s" }, bogus: 1 },
      ],
      ["flink", { ...validFlinkBlock, bogus: 1 }],
    ])("should reject unknown keys in the %s block", (block, value) => {
      const result = mcpConfigSchema.safeParse({
        connections: { production: { type: "direct", [block]: value } },
      });
      expect(result.success).toBe(false);
    });
  });

  describe("flink block required fields", () => {
    it.each([
      "endpoint",
      "auth",
      "environment_id",
      "organization_id",
      "compute_pool_id",
    ])("should reject flink block with '%s' omitted", (field) => {
      const flink = { ...validFlinkBlock, [field]: undefined };
      const result = mcpConfigSchema.safeParse({
        connections: { production: { type: "direct", flink } },
      });
      expect(result.success).toBe(false);
    });

    it.each(["environment_name", "database_name"])(
      "should reject flink block with empty string for optional field '%s'",
      (field) => {
        const flink = { ...validFlinkBlock, [field]: "" };
        const result = mcpConfigSchema.safeParse({
          connections: { production: { type: "direct", flink } },
        });
        expect(result.success).toBe(false);
      },
    );

    it.each([
      ["environment_id", "bad-id"],
      ["compute_pool_id", "bad-id"],
    ])(
      "should reject flink block with invalid prefix for '%s'",
      (field, value) => {
        const flink = { ...validFlinkBlock, [field]: value };
        const result = mcpConfigSchema.safeParse({
          connections: { production: { type: "direct", flink } },
        });
        expect(result.success).toBe(false);
      },
    );
  });

  describe("MCPServerConfiguration", () => {
    describe("getConnectionNames", () => {
      it("should return connection names sorted alphabetically", () => {
        const config = new MCPServerConfiguration({
          connections: { staging: directConnection, local: directConnection },
        });

        expect(config.getConnectionNames()).toEqual(["local", "staging"]);
      });
    });

    describe("getSoleConnection", () => {
      it("should return the single defined connection", () => {
        const config = new MCPServerConfiguration({
          connections: { local: directConnection },
        });

        expect(config.getSoleConnection()).toBe(directConnection);
      });

      it("should throw when no connections are defined", () => {
        const config = new MCPServerConfiguration({ connections: {} });

        expect(() => config.getSoleConnection()).toThrow(
          /No connections defined/,
        );
      });

      it("should throw when more than one connection is defined", () => {
        const config = new MCPServerConfiguration({
          connections: {
            local: directConnection,
            staging: {
              type: "direct",
              kafka: { bootstrap_servers: "staging:9092" },
            },
          },
        });

        expect(() => config.getSoleConnection()).toThrow(
          /Multiple connections defined/,
        );
      });
    });
  });
});
