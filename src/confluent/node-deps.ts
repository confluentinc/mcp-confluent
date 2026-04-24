// Wrappers for easier stubbing in tests — ESM live bindings can't be stubbed at runtime,
// but property access on these namespace objects can be (via `vi.spyOn`).
import { Analytics } from "@segment/analytics-node";
import { TELEMETRY_WRITE_KEY } from "@src/build-config.js";
import envProxy from "@src/env.js";
import * as dotenv from "dotenv";
import { randomBytes } from "node:crypto";
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
export const nodeFetch = { fetch: globalThis.fetch };
// Wrapped as a single-signature arrow so spies don't have to disambiguate
// between the sync and callback overloads of the underlying `node:crypto`
// `randomBytes`. The codebase only uses the sync form.
export const nodeCrypto = {
  randomBytes: (size: number): Buffer => randomBytes(size),
};
