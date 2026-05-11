import type { CLIOptions } from "@src/cli.js";
import type { MCPServerConfiguration } from "@src/config/models.js";
import type { TransportType } from "@src/mcp/transports/types.js";

/**
 * Wire shape of the connection-type label on telemetry events. The internal
 * schema discriminator uses `"direct"` and `"oauth"`; the telemetry label
 * remaps the latter to `"ccloud-oauth"` because today's OAuth arm is
 * specifically Confluent Cloud OAuth (PKCE against CCloud Auth0). If a
 * non-CCloud OAuth arm ever lands, {@link buildConfigTelemetry}'s mapping
 * needs to grow.
 */
export type ConnectionTelemetryType = "direct" | "ccloud-oauth";

/**
 * Result of {@link buildConfigTelemetry}. Three orthogonal dimensions captured
 * once at server start and emitted as the payload of `SERVER_START`. They are
 * boot-time invariants, so they don't ride TOOL_CALL events — warehouse joins
 * on `serverSessionId` recover the link when slicing is needed. See #264.
 */
export interface ConfigTelemetry {
  /** Which branch of `main()` built the `MCPServerConfiguration`. */
  configSource: "yaml" | "env-vars";
  /** Sorted, deduplicated list of active MCP serving listeners. */
  transports: TransportType[];
  /**
   * Sorted list of each declared connection's wire type. Length equals the
   * connection count; duplicates reflect multiple connections of the same
   * type (relevant once multi-connection lands — today always length 1).
   */
  connectionTypes: ConnectionTelemetryType[];
}

/**
 * Derive the {@link ConfigTelemetry} bundle from the inputs already in scope
 * at the end of `main()`'s bootstrap (resolved CLI options, validated
 * `MCPServerConfiguration`, and the resolved list of active transports).
 */
export function buildConfigTelemetry(
  cliOptions: CLIOptions,
  mcpConfig: MCPServerConfiguration,
  transports: readonly TransportType[],
): ConfigTelemetry {
  const byLocale = (a: string, b: string): number => a.localeCompare(b);
  const connectionTypes = Object.values(mcpConfig.connections)
    .map<ConnectionTelemetryType>((conn) =>
      conn.type === "oauth" ? "ccloud-oauth" : "direct",
    )
    .sort(byLocale);
  return {
    configSource: cliOptions.config ? "yaml" : "env-vars",
    transports: [...new Set(transports)].sort(byLocale),
    connectionTypes,
  };
}
