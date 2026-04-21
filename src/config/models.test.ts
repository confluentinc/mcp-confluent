import { MCPServerConfiguration, mcpConfigSchema } from "@src/config/models.js";
import { describe, expect, it } from "vitest";

const directConnection = {
  type: "direct" as const,
  kafka: { bootstrap_servers: "localhost:9092" },
};

describe("config/models.ts", () => {
  describe("mcpConfigSchema", () => {
    it("should reject unknown keys at the document root", () => {
      const result = mcpConfigSchema.safeParse({
        conenctions: { local: directConnection },
      });

      expect(result.success).toBe(false);
    });
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
