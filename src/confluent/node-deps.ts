// Wrappers for easier stubbing in tests since sinon can't stub ES module imports directly
import { Analytics } from "@segment/analytics-node";
import envProxy from "@src/env.js";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { join } from "node:path";

export const fs = { readFileSync, writeFileSync, mkdirSync };
export const os = { homedir, platform, release, arch };
export const crypto = { randomUUID };
export const path = { join };
export const segment = { Analytics };
export const env = { current: envProxy };
