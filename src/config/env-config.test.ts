import { consConfigFromEnv } from "@src/config/env-config.js";
import { describe, expect, it } from "vitest";

describe("config/env-config.ts", () => {
  describe("consConfigFromEnv", () => {
    describe("most minimal configurations --- only BOOTSTRAP_SERVERS or SCHEMA_REGISTRY_ENDPOINT set", () => {
      it("should build a config with both kafka and schema_registry when both env vars are set", () => {
        const config = consConfigFromEnv({
          BOOTSTRAP_SERVERS: "localhost:9092",
          SCHEMA_REGISTRY_ENDPOINT: "http://localhost:8081",
        });

        const conn = config.getSoleConnection();
        expect(conn.type).toBe("direct");
        expect(conn.kafka?.bootstrap_servers).toBe("localhost:9092");
        expect(conn.schema_registry?.endpoint).toBe("http://localhost:8081");
      });

      it("should use 'env-connection' as the connection name", () => {
        const config = consConfigFromEnv({
          BOOTSTRAP_SERVERS: "localhost:9092",
          SCHEMA_REGISTRY_ENDPOINT: undefined,
        });

        expect(Object.keys(config.connections)).toEqual(["env-connection"]);
      });

      it("should build a kafka-only config when only BOOTSTRAP_SERVERS is set", () => {
        const config = consConfigFromEnv({
          BOOTSTRAP_SERVERS: "broker1:9092,broker2:9092",
          SCHEMA_REGISTRY_ENDPOINT: undefined,
        });

        const conn = config.getSoleConnection();
        expect(conn.kafka?.bootstrap_servers).toBe("broker1:9092,broker2:9092");
        expect(conn.schema_registry).toBeUndefined();
      });

      it("should build a schema_registry-only config when only SCHEMA_REGISTRY_ENDPOINT is set", () => {
        const config = consConfigFromEnv({
          BOOTSTRAP_SERVERS: undefined,
          SCHEMA_REGISTRY_ENDPOINT: "https://sr.example.com:8081",
        });

        const conn = config.getSoleConnection();
        expect(conn.schema_registry?.endpoint).toBe(
          "https://sr.example.com:8081",
        );
        expect(conn.kafka).toBeUndefined();
      });

      it("should throw when neither env var is set", () => {
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: undefined,
            SCHEMA_REGISTRY_ENDPOINT: undefined,
          }),
        ).toThrow(
          /Failed to construct MCPServerConfiguration from environment variables/,
        );
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: undefined,
            SCHEMA_REGISTRY_ENDPOINT: undefined,
          }),
        ).toThrow(
          /At least one of 'kafka' or 'schema_registry' must be defined/,
        );
      });

      it("should throw when BOOTSTRAP_SERVERS has an invalid format", () => {
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: "invalid-no-port",
            SCHEMA_REGISTRY_ENDPOINT: undefined,
          }),
        ).toThrow(
          /Failed to construct MCPServerConfiguration from environment variables/,
        );
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: "invalid-no-port",
            SCHEMA_REGISTRY_ENDPOINT: undefined,
          }),
        ).toThrow(/Invalid format 'invalid-no-port': must be host:port/);
      });
    });
  });
});
