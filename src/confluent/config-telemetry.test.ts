import type { CLIOptions } from "@src/cli.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import { buildConfigTelemetry } from "@src/confluent/config-telemetry.js";
import { TransportType } from "@src/mcp/transports/types.js";
import { describe, expect, it } from "vitest";

/**
 * Minimal `CLIOptions` shape. `buildConfigTelemetry` only reads `config`, so
 * the rest of the fields are filled with cheap defaults.
 */
function makeCliOptions(overrides: Partial<CLIOptions> = {}): CLIOptions {
  return {
    transports: [],
    listTools: false,
    generateKey: false,
    initConfig: false,
    initOauthConfig: false,
    ...overrides,
  };
}

function configWithConnections(
  connectionTypes: Array<"direct" | "oauth">,
): MCPServerConfiguration {
  const connections = Object.fromEntries(
    connectionTypes.map((type, i) => [
      `conn-${i}`,
      type === "oauth"
        ? { type: "oauth" as const, ccloud_env: "prod" as const }
        : { type: "direct" as const },
    ]),
  );
  return new MCPServerConfiguration({ connections });
}

describe("config-telemetry.ts", () => {
  describe("buildConfigTelemetry()", () => {
    it("should set configSource to 'yaml' when cliOptions.config is provided", () => {
      const result = buildConfigTelemetry(
        makeCliOptions({ config: "/path/to/config.yaml" }),
        configWithConnections(["direct"]),
        [TransportType.STDIO],
      );

      expect(result.configSource).toBe("yaml");
    });

    it("should set configSource to 'env-vars' when cliOptions.config is absent", () => {
      const result = buildConfigTelemetry(
        makeCliOptions(),
        configWithConnections(["direct"]),
        [TransportType.STDIO],
      );

      expect(result.configSource).toBe("env-vars");
    });

    it("should report a direct connection as ['direct']", () => {
      const result = buildConfigTelemetry(
        makeCliOptions(),
        configWithConnections(["direct"]),
        [TransportType.STDIO],
      );

      expect(result.connectionTypes).toEqual(["direct"]);
    });

    it("should map an internal 'oauth' connection type to the wire label 'ccloud-oauth'", () => {
      // The user-facing telemetry label is 'ccloud-oauth' even though the
      // discriminated-union arm in the schema is 'oauth' — today's OAuth
      // arm is specifically Confluent Cloud OAuth via PKCE, and the wire
      // label is honest about it.
      const result = buildConfigTelemetry(
        makeCliOptions(),
        configWithConnections(["oauth"]),
        [TransportType.STDIO],
      );

      expect(result.connectionTypes).toEqual(["ccloud-oauth"]);
    });

    it("should return the transports list sorted for cross-event comparability", () => {
      const result = buildConfigTelemetry(
        makeCliOptions(),
        configWithConnections(["direct"]),
        [TransportType.HTTP, TransportType.STDIO, TransportType.SSE],
      );

      expect(result.transports).toEqual([
        TransportType.HTTP,
        TransportType.SSE,
        TransportType.STDIO,
      ]);
    });
  });
});
