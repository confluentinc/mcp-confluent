// Wrappers for easier stubbing in tests since sinon can't stub ES module imports directly
import { Analytics } from "@segment/analytics-node";
import { TELEMETRY_WRITE_KEY } from "@src/build-config.js";
import envProxy from "@src/env.js";
import * as dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { join, resolve } from "node:path";

export const buildConfig = { TELEMETRY_WRITE_KEY };
export const dotenvLib = { config: dotenv.config };
export const fs = { existsSync, readFileSync, writeFileSync, mkdirSync };
export const os = { homedir, platform, release, arch };
export const path = { join, resolve };
export const segment = { Analytics };
export const config = { env: envProxy };
