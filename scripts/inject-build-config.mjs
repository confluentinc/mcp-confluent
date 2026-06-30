#!/usr/bin/env node

// Rewrites dist/build-config.js with environment variable values so that
// `npm pack` produces a tarball with the real keys baked in.
//
// Runs as the `prepack` lifecycle script. Any env var that is unset or empty
// keeps its compiled default (empty string).

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distFile = join(__dirname, "..", "dist", "build-config.js");

const TELEMETRY_WRITE_KEY = process.env.TELEMETRY_WRITE_KEY ?? "";
const SENTRY_DSN = process.env.SENTRY_DSN ?? "";

const content = [
  "// build-time values injected by scripts/inject-build-config.mjs during `npm pack`",
  `export const TELEMETRY_WRITE_KEY = ${JSON.stringify(TELEMETRY_WRITE_KEY)};`,
  `export const SENTRY_DSN = ${JSON.stringify(SENTRY_DSN)};`,
  "",
].join("\n");

writeFileSync(distFile, content, "utf-8");

const status = TELEMETRY_WRITE_KEY ? "set" : "empty (env var not provided)";
console.log(`inject-build-config: TELEMETRY_WRITE_KEY ${status}`);
const sentryStatus = SENTRY_DSN ? "set" : "empty (env var not provided)";
console.log(`inject-build-config: SENTRY_DSN ${sentryStatus}`);
