import { CLIOptions, getLogDir } from "@src/cli.js";
import { join } from "path";
import { pino } from "pino";

const logLevel = process.env.LOG_LEVEL || "info";

// Create a default logger that will be used before initialization
let logger = pino({ level: logLevel }, pino.destination(2));

/**
 * Initialize the logger with the given CLI options
 * @param cliOptions - The parsed CLI options from parseCliArgs()
 */
export function initLogger(cliOptions: CLIOptions) {
  const logDir = getLogDir(cliOptions);

  const transport = pino.transport({
    target: "pino-roll",
    options: {
      file: join(logDir, "mcp-confluent.log"),
      size: "10m",
      keep: 7,
      mkdir: true,
    },
  });

  // Create logger with transport
  logger = pino(transport, pino.destination(2));
  logger.level = logLevel;
}

// Export the logger instance
export { logger };

// Export log levels for type safety
export const logLevels = {
  fatal: 60,
  error: 50,
  warn: 40,
  info: 30,
  debug: 20,
  trace: 10,
} as const;

export type LogLevel = keyof typeof logLevels;
