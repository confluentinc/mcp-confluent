import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// load .env.integration if present so local runs pick up creds without a shell wrapper
// (CI populates process.env directly via vault, so the file lookup is a no-op)
//
// NOTE: there is no global required-vars check; each integration test gates on exactly the
// creds it needs via early-return pattern
const envFile = resolve(process.cwd(), ".env.integration");
if (existsSync(envFile)) {
  loadDotenv({ path: envFile, override: false });
}

// signal for downstream test-aware behavior (e.g. node-deps.ts skipping the
// system-browser open during PKCE). inherits into spawned children via the
// harness's env-copy, so the same flag covers both processes. always set
// during integration runs; production users never see it.
process.env.INTEGRATION_TEST = "1";
