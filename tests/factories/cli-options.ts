import type { CLIOptions } from "@src/cli.js";
import { TransportType } from "@src/mcp/transports/types.js";

const BASE_CLI_OPTIONS: CLIOptions = {
  transports: [TransportType.STDIO],

  envFile: undefined,
  config: undefined,
  allowTools: undefined,
  blockTools: undefined,
  listTools: false,
  disableConfluentCloudTools: false,
  disableAuth: false,
  allowedHosts: undefined,
  generateKey: false,
};

/**
 * Constructs a minimal valid {@link CLIOptions} for use in tests.
 * Pass overrides to exercise specific CLI option combinations.
 */
export function cliOptionsFactory(
  overrides: Partial<CLIOptions> = {},
): CLIOptions {
  return { ...BASE_CLI_OPTIONS, ...overrides };
}
