import { loadConfigFromYaml } from "@src/config/index.js";
import { MCPServerConfiguration } from "@src/config/models.js";
import {
  assertExpectedConnections,
  CCLOUD_CONNECTION_ID,
  CP_CONNECTION_ID,
  isMissingInterpolationVar,
} from "@tests/harness/multi-runtime.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Writes `content` to a throwaway YAML file and returns its path. */
function tempYaml(content: string): string {
  const path = join(
    mkdtempSync(join(tmpdir(), "multi-runtime-test-")),
    "config.yaml",
  );
  writeFileSync(path, content);
  return path;
}

/** Runs {@link loadConfigFromYaml} expecting failure, returning the thrown error. */
function loadError(
  content: string,
  env: Record<string, string | undefined> = {},
): unknown {
  try {
    loadConfigFromYaml(tempYaml(content), env);
  } catch (error) {
    return error;
  }
  throw new Error("expected loadConfigFromYaml to throw but it succeeded");
}

describe("isMissingInterpolationVar", () => {
  // The skip-eligible case: a required ${VAR} absent from env (creds not
  // configured) — the only failure the @multi suite should silently skip on.
  it("should classify a missing ${VAR} as the skip-eligible case", () => {
    const error = loadError(
      'connections:\n  c:\n    type: direct\n    kafka:\n      bootstrap_servers: "${UNSET_MULTI_TEST_VAR}"\n',
      {},
    );
    expect((error as Error).message).toContain(
      "Environment variable not found",
    );
    expect(isMissingInterpolationVar(error)).toBe(true);
  });

  // A malformed fixture is a real regression, not a creds-skip: it must fail
  // loudly rather than green-skip the suite.
  it("should not classify a malformed-YAML error as skip-eligible", () => {
    const error = loadError("connections: [unterminated\n");
    expect((error as Error).message).toContain("Failed to parse YAML");
    expect(isMissingInterpolationVar(error)).toBe(false);
  });

  // A schema-invalid fixture is likewise a real regression that must propagate.
  it("should not classify a schema-validation error as skip-eligible", () => {
    const error = loadError("connections:\n  c:\n    type: not-a-real-type\n");
    expect((error as Error).message).toContain(
      "Configuration validation failed",
    );
    expect(isMissingInterpolationVar(error)).toBe(false);
  });

  it("should not classify a non-Error value as skip-eligible", () => {
    expect(isMissingInterpolationVar("some string")).toBe(false);
    expect(isMissingInterpolationVar(undefined)).toBe(false);
  });
});

/** Builds a config holding exactly the given connection ids (minimal direct connections). */
function configWith(ids: string[]): MCPServerConfiguration {
  return new MCPServerConfiguration({
    connections: Object.fromEntries(ids.map((id) => [id, { type: "direct" }])),
  });
}

describe("assertExpectedConnections", () => {
  it("should pass when both ccloud and cp are present", () => {
    expect(() =>
      assertExpectedConnections(
        configWith([CCLOUD_CONNECTION_ID, CP_CONNECTION_ID]),
      ),
    ).not.toThrow();
  });

  // A loaded fixture missing an expected id is drift, not a creds-skip: it must
  // throw loudly rather than green-skip the suite.
  it("should throw naming the missing cp connection (fixture drift)", () => {
    expect(() =>
      assertExpectedConnections(configWith([CCLOUD_CONNECTION_ID])),
    ).toThrow(/"cp".*drift|drift.*"cp"|missing connection id "cp"/i);
  });

  it("should throw naming the missing ccloud connection (fixture drift)", () => {
    expect(() =>
      assertExpectedConnections(configWith([CP_CONNECTION_ID])),
    ).toThrow(/ccloud/);
  });
});
