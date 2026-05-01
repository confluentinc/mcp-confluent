import { KafkaJS } from "@confluentinc/kafka-javascript";
import pino from "pino";

const logLevel = process.env.LOG_LEVEL || "info";

const STDERR = 2;
// when LOG_PRETTY=true, pipe through pino-pretty for human-readable dev output
const destination =
  process.env.LOG_PRETTY === "true"
    ? pino.transport({
        target: "pino-pretty",
        options: { destination: STDERR, singleLine: true },
      })
    : pino.destination(STDERR);

export const logger = pino(
  {
    level: logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    name: "mcp-confluent",
    formatters: {
      level: (label) => {
        return {
          level: label,
        };
      },
    },
  },
  destination,
);

/**
 * Wraps a pino child logger in the shape KafkaJS expects. Both the `logLevel`
 * option on `namespace()` and the `setLogLevel` method are no-ops: KafkaJS
 * uses them to announce its internal level (usually INFO), but the library
 * still filters its own `.info/.debug/...` calls on its end before they reach
 * us. Honoring them would let a KafkaJS default override the user's
 * `env.LOG_LEVEL`; ignoring them keeps `env.LOG_LEVEL` the single floor for
 * the whole app. The child logger just inherits `baseLogger.level`.
 */
const createKafkaLogger = (
  baseLogger: pino.Logger,
  namespace: string,
): KafkaJS.Logger => {
  const childLogger = baseLogger.child({ namespace });

  return {
    namespace: (subNamespace: string) =>
      createKafkaLogger(childLogger, subNamespace),
    error: (message: string, ...args: unknown[]) => {
      childLogger.error({ args }, message);
    },
    warn: (message: string, ...args: unknown[]) => {
      childLogger.warn({ args }, message);
    },
    info: (message: string, ...args: unknown[]) => {
      childLogger.info({ args }, message);
    },
    debug: (message: string, ...args: unknown[]) => {
      childLogger.debug({ args }, message);
    },
    setLogLevel: () => {},
  };
};

// Create the root Kafka logger
export const kafkaLogger: KafkaJS.Logger = createKafkaLogger(logger, "kafka");

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

// Add a function to update the logger's level after env is initialized
export function setLogLevel(level: LogLevel) {
  logger.level = level;
}
