import { loadConfigFromYaml } from "@src/config/index.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const FIXTURES_DIR = fileURLToPath(
  new URL("../../test-fixtures/yaml_configs", import.meta.url),
);

function fixtureFile(relative: string): string {
  return path.join(FIXTURES_DIR, relative);
}

const NO_ENV: Record<string, string | undefined> = {};

describe("config/yaml-fixtures.test.ts", () => {
  describe("valid fixtures", () => {
    it("should load kafka-only config", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/kafka-only.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.type).toBe("direct");
      expect(conn.kafka?.bootstrap_servers).toBe("localhost:9092");
      expect(conn.kafka?.auth).toBeUndefined();
      expect(conn.schema_registry).toBeUndefined();
    });

    it("should load sr-only config", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/sr-only.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.type).toBe("direct");
      expect(conn.schema_registry?.endpoint).toBe("http://localhost:8081");
      expect(conn.schema_registry?.auth).toBeUndefined();
      expect(conn.kafka).toBeUndefined();
    });

    it("should load kafka-and-sr config with no auth", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/kafka-and-sr.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.kafka?.bootstrap_servers).toBe("localhost:9092");
      expect(conn.kafka?.auth).toBeUndefined();
      expect(conn.schema_registry?.endpoint).toBe("http://localhost:8081");
      expect(conn.schema_registry?.auth).toBeUndefined();
    });

    it("should load kafka-with-auth and parse the auth block", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/kafka-with-auth.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.kafka?.auth).toEqual({
        type: "api_key",
        key: "mykafkakey",
        secret: "mykafkasecret",
      });
      expect(conn.schema_registry).toBeUndefined();
    });

    it("should load sr-with-auth and parse the auth block", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/sr-with-auth.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.schema_registry?.auth).toEqual({
        type: "api_key",
        key: "mysrkey",
        secret: "mysrsecret",
      });
      expect(conn.kafka).toBeUndefined();
    });

    it("should load kafka-and-sr-both-with-auth with auth on both sides", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/kafka-and-sr-both-with-auth.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.kafka?.auth).toEqual({
        type: "api_key",
        key: "mykafkakey",
        secret: "mykafkasecret",
      });
      expect(conn.schema_registry?.auth).toEqual({
        type: "api_key",
        key: "mysrkey",
        secret: "mysrsecret",
      });
    });

    it("should resolve ${VAR} interpolation in auth fields", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/kafka-with-interpolated-auth.yaml"),
        { KAFKA_API_KEY: "envkey", KAFKA_API_SECRET: "envsecret" },
      );
      const conn = config.getSoleConnection();
      expect(conn.kafka?.auth).toEqual({
        type: "api_key",
        key: "envkey",
        secret: "envsecret",
      });
    });
  });

  describe("invalid fixtures", () => {
    it("should reject auth block missing secret", () => {
      expect(() =>
        loadConfigFromYaml(
          fixtureFile("invalid/auth-missing-secret.yaml"),
          NO_ENV,
        ),
      ).toThrow(/Configuration validation failed/);
    });

    it("should reject auth block missing key", () => {
      expect(() =>
        loadConfigFromYaml(
          fixtureFile("invalid/auth-missing-key.yaml"),
          NO_ENV,
        ),
      ).toThrow(/Configuration validation failed/);
    });

    it("should reject auth block with unknown type", () => {
      expect(() =>
        loadConfigFromYaml(
          fixtureFile("invalid/auth-unknown-type.yaml"),
          NO_ENV,
        ),
      ).toThrow(/Configuration validation failed/);
    });

    it("should reject auth block with empty key string", () => {
      expect(() =>
        loadConfigFromYaml(fixtureFile("invalid/auth-empty-key.yaml"), NO_ENV),
      ).toThrow(/Configuration validation failed/);
    });

    it("should include a descriptive field path in error messages for missing secret", () => {
      expect(() =>
        loadConfigFromYaml(
          fixtureFile("invalid/auth-missing-secret.yaml"),
          NO_ENV,
        ),
      ).toThrow(/auth/);
    });

    it("should include a descriptive field path in error messages for empty key", () => {
      expect(() =>
        loadConfigFromYaml(fixtureFile("invalid/auth-empty-key.yaml"), NO_ENV),
      ).toThrow(/auth\.key cannot be empty/);
    });
  });
});
