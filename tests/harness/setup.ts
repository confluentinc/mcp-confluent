import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

// load .env.integration if present so local runs pick up creds without a shell wrapper
// (CI populates process.env directly via vault, so the file lookup is a no-op)
//
// NOTE: there is no global required-vars check; each integration test uses `describe.skipIf` to
// gate on exactly the creds it needs. this lets a user with only Kafka creds
// (e.g. BOOTSTRAP_SERVERS, KAFKA_*) run the @kafka tests while skipping other tests
const envFile = resolve(process.cwd(), ".env.integration");
if (existsSync(envFile)) {
  loadDotenv({ path: envFile, override: false });
}
