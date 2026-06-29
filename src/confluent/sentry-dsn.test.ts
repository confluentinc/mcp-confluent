import { buildConfig } from "@src/confluent/node-deps.js";
import { describe, expect, it } from "vitest";

describe("build-config Sentry DSN", () => {
  it("exposes a SENTRY_DSN string (empty in dev builds)", () => {
    expect(buildConfig).toHaveProperty("SENTRY_DSN");
    expect(typeof buildConfig.SENTRY_DSN).toBe("string");
  });
});
