// Wrappers for easier stubbing in tests — ESM live bindings can't be stubbed at runtime,
// but property access on these namespace objects can be (via `vi.spyOn`).
import { KafkaJS } from "@confluentinc/kafka-javascript";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Analytics } from "@segment/analytics-node";
import * as Sentry from "@sentry/node";
import { SENTRY_DSN, TELEMETRY_WRITE_KEY } from "@src/build-config.js";
import * as dotenv from "dotenv";
import { randomBytes, randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer as httpCreateServer } from "node:http";
import { arch, homedir, platform, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export const buildConfig = { TELEMETRY_WRITE_KEY, SENTRY_DSN };
export const dotenvLib = { config: dotenv.config };
export const fs = {
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
};
export const os = { homedir, platform, release, arch };
export const path = { join, resolve, dirname, basename };
export const segment = { Analytics };
// Explicit `typeof` annotations keep the inferred type anchored to the
// `@sentry/node` namespace import — without them tsc tries to name transitive
// `@sentry/core` types via a non-portable pnpm path (TS2742/TS4023).
export const sentry: {
  init: typeof Sentry.init;
  captureException: typeof Sentry.captureException;
  close: typeof Sentry.close;
  rewriteFramesIntegration: typeof Sentry.rewriteFramesIntegration;
} = {
  init: Sentry.init,
  captureException: Sentry.captureException,
  close: Sentry.close,
  rewriteFramesIntegration: Sentry.rewriteFramesIntegration,
};
export const nodeFetch = { fetch: globalThis.fetch };
// Wrapped as a single-signature arrow so spies don't have to disambiguate
// between the sync and callback overloads of the underlying `node:crypto`
// `randomBytes`. The codebase only uses the sync form.
export const nodeCrypto = {
  randomBytes: (size: number): Buffer => randomBytes(size),
  randomUUID: (): string => randomUUID(),
};
export const nodeHttp = { createServer: httpCreateServer };
// `open` is loaded lazily so non-OAuth runs don't pay the import cost (it
// pulls in is-wsl, default-browser, etc.).
export const nodeOpen = {
  open: async (target: string): Promise<void> => {
    // skip during integration test runs: playwright drives auth headlessly, so a system-browser
    // open is redundant and would race on the OAuth callback port.
    // eslint-disable-next-line no-restricted-syntax -- localized test seam, not a config read
    if (process.env.INTEGRATION_TEST === "1") return;
    const { default: open } = await import("open");
    await open(target);
  },
};
export const sdkTransports = {
  StreamableHTTPServerTransport,
  SSEServerTransport,
};
// KafkaJS constructor wrapped so tests can spy on `kafkaDeps.Kafka` and return
// a mock Kafka instance without needing vi.mock on the external module.
export const kafkaDeps = { Kafka: KafkaJS.Kafka };
