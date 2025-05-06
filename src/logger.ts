import { pino } from "pino";

const logLevel = process.env.LOG_LEVEL || "info";

// Create logger with stderr destination
export const logger = pino(
  {
    level: logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.destination(2),
);

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
