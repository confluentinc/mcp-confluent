import { KafkaJS } from "@confluentinc/kafka-javascript";
import { pino } from "pino";

const logLevel = process.env.LOG_LEVEL || "info";

// Create logger with stderr destination
export const logger = pino(
  {
    level: logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    name: "mcp-confluent",
  },
  pino.destination(2),
);

// Map Kafka log levels to Pino levels
const levelMap: Record<KafkaJS.logLevel, pino.Level> = {
  [KafkaJS.logLevel.NOTHING]: "trace",
  [KafkaJS.logLevel.ERROR]: "error",
  [KafkaJS.logLevel.WARN]: "warn",
  [KafkaJS.logLevel.INFO]: "info",
  [KafkaJS.logLevel.DEBUG]: "debug",
};

// Create a logger with the given namespace and level
const createKafkaLogger = (
  baseLogger: pino.Logger,
  namespace: string,
  logLevel?: KafkaJS.logLevel,
): KafkaJS.Logger => {
  const childLogger = baseLogger.child({ namespace });
  if (logLevel) {
    childLogger.level = levelMap[logLevel] || "info";
  }

  return {
    namespace: (subNamespace: string, subLogLevel?: KafkaJS.logLevel) =>
      createKafkaLogger(childLogger, subNamespace, subLogLevel),
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
    setLogLevel: (level: KafkaJS.logLevel) => {
      childLogger.level = levelMap[level] || "info";
    },
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
