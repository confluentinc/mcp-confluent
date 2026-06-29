import { buildConfig, sentry } from "@src/confluent/node-deps.js";
import { redactEvent } from "@src/confluent/sentry-redact.js";
import { logger } from "@src/logger.js";

let initialized = false;

/** DSN baked at pack time; empty (-> disabled) on dev/unpacked builds. */
export function resolveSentryDsn(): string | undefined {
  return buildConfig.SENTRY_DSN || undefined;
}

export interface InitSentryOptions {
  readonly doNotTrack: boolean;
  readonly dsn: string | undefined;
  readonly release: string;
  readonly transports: readonly string[];
}

/**
 * Initialize crash reporting. Short-circuits — no DSN registered, no transport,
 * no global handlers — when the user has opted out or no DSN was baked in. Uses
 * the same resolved `doNotTrack` value as usage analytics, so one switch
 * disables both.
 */
export function initSentry(opts: InitSentryOptions): void {
  if (opts.doNotTrack || !opts.dsn) {
    logger.info("Crash reporting disabled");
    return;
  }
  sentry.init({
    dsn: opts.dsn,
    release: opts.release,
    debug: false,
    attachStacktrace: true,
    includeLocalVariables: false,
    tracesSampleRate: 0,
    profilesSampleRate: 0,
    // Defense in depth on top of `beforeSend`: this server handles credentials,
    // so never attach HTTP bodies (may carry secrets) and don't set user.* fields.
    dataCollection: {
      userInfo: false,
      httpBodies: [],
    },
    initialScope: {
      tags: {
        transport: [...opts.transports]
          .sort((a, b) => a.localeCompare(b))
          .join(","),
      },
    },
    integrations: (defaults) => [
      ...defaults,
      sentry.rewriteFramesIntegration(),
    ],
    beforeSend: (event) => redactEvent(event),
  });
  initialized = true;
  logger.info("Crash reporting enabled");
}

/** Report an error. No-op until {@link initSentry} has registered a client. */
export function captureException(
  error: unknown,
  context?: { tags?: Record<string, string> },
): void {
  if (!initialized) return;
  sentry.captureException(error, context);
}

/** Flush buffered events on shutdown. No-op when uninitialized. */
export async function closeSentry(timeoutMs = 2000): Promise<boolean> {
  if (!initialized) return true;
  return sentry.close(timeoutMs);
}
