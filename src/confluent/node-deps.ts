// Wrappers for easier stubbing in tests since sinon can't stub ES module imports directly
import { Analytics } from "@segment/analytics-node";
import { TELEMETRY_WRITE_KEY } from "@src/build-config.js";
import envProxy from "@src/env.js";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { join } from "node:path";

export const buildConfig = { TELEMETRY_WRITE_KEY };
export const fs = { existsSync, readFileSync, writeFileSync, mkdirSync };
export const os = { homedir, platform, release, arch };
export const path = { join };
export const segment = { Analytics };
export const config = { env: envProxy };
export const nodeFetch = { fetch: globalThis.fetch };
export const nodeCrypto = { randomBytes };
