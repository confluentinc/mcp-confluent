import { MCPServerConfiguration } from "@src/config/models.js";
import { hasIntegrationConnection } from "@tests/harness/runtime.js";
import { describe, expect, it } from "vitest";

describe("runtime.ts", () => {
  describe("hasIntegrationConnection()", () => {
    it("should return true for a single-connection config", () => {
      expect(
        hasIntegrationConnection(
          new MCPServerConfiguration({
            connections: { a: { type: "direct" } },
          }),
        ),
      ).toBe(true);
    });

    // Regression guard for the multi-connection smoke-gate bug: the prior
    // implementation resolved the *sole* connection, so a loaded multi-connection
    // config threw and read as "not loaded" — wrongly skipping the transport
    // smoke tests now that multiple connections are allowed.
    it("should return true for a multi-connection config (the prior sole-connection check threw here)", () => {
      const multi = new MCPServerConfiguration({
        connections: { a: { type: "direct" }, b: { type: "direct" } },
      });
      expect(hasIntegrationConnection(multi)).toBe(true);
    });

    it("should return false for a config with no connections", () => {
      expect(
        hasIntegrationConnection(
          new MCPServerConfiguration({ connections: {} }),
        ),
      ).toBe(false);
    });
  });
});
