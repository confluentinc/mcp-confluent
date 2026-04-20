import { consConfigFromEnv } from "@src/config/env-config.js";
import { describe, expect, it } from "vitest";

describe("config/env-config.ts", () => {
  describe("consConfigFromEnv", () => {
    describe("most minimal configurations --- only (BOOTSTRAP_SERVERS and/or SCHEMA_REGISTRY_ENDPOINT) set", () => {
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

    describe("with auth env vars", () => {
      it("should populate kafka auth when both KAFKA_API_KEY and KAFKA_API_SECRET are set", () => {
        const config = consConfigFromEnv({
          BOOTSTRAP_SERVERS: "localhost:9092",
          SCHEMA_REGISTRY_ENDPOINT: undefined,
          KAFKA_API_KEY: "mykey",
          KAFKA_API_SECRET: "mysecret",
          SCHEMA_REGISTRY_API_KEY: undefined,
          SCHEMA_REGISTRY_API_SECRET: undefined,
        });
        const conn = config.getSoleConnection();
        expect(conn.kafka?.auth).toEqual({
          type: "api_key",
          key: "mykey",
          secret: "mysecret",
        });
      });

      it("should populate schema_registry auth when both SR vars are set", () => {
        const config = consConfigFromEnv({
          BOOTSTRAP_SERVERS: undefined,
          SCHEMA_REGISTRY_ENDPOINT: "https://sr.example.com",
          KAFKA_API_KEY: undefined,
          KAFKA_API_SECRET: undefined,
          SCHEMA_REGISTRY_API_KEY: "srkey",
          SCHEMA_REGISTRY_API_SECRET: "srsecret",
        });
        const conn = config.getSoleConnection();
        expect(conn.schema_registry?.auth).toEqual({
          type: "api_key",
          key: "srkey",
          secret: "srsecret",
        });
      });

      it("should populate auth on both sides when all four auth vars are set", () => {
        const config = consConfigFromEnv({
          BOOTSTRAP_SERVERS: "localhost:9092",
          SCHEMA_REGISTRY_ENDPOINT: "https://sr.example.com",
          KAFKA_API_KEY: "kafkakey",
          KAFKA_API_SECRET: "kafkasecret",
          SCHEMA_REGISTRY_API_KEY: "srkey",
          SCHEMA_REGISTRY_API_SECRET: "srsecret",
        });
        const conn = config.getSoleConnection();
        expect(conn.kafka?.auth).toEqual({
          type: "api_key",
          key: "kafkakey",
          secret: "kafkasecret",
        });
        expect(conn.schema_registry?.auth).toEqual({
          type: "api_key",
          key: "srkey",
          secret: "srsecret",
        });
      });
    });

    describe("partial auth credentials (misconfiguration)", () => {
      it("should throw when KAFKA_API_KEY is set but KAFKA_API_SECRET is missing", () => {
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: "localhost:9092",
            SCHEMA_REGISTRY_ENDPOINT: undefined,
            KAFKA_API_KEY: "mykey",
            KAFKA_API_SECRET: undefined,
            SCHEMA_REGISTRY_API_KEY: undefined,
            SCHEMA_REGISTRY_API_SECRET: undefined,
          }),
        ).toThrow(/KAFKA_API_SECRET/);
      });

      it("should throw when KAFKA_API_SECRET is set but KAFKA_API_KEY is missing", () => {
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: "localhost:9092",
            SCHEMA_REGISTRY_ENDPOINT: undefined,
            KAFKA_API_KEY: undefined,
            KAFKA_API_SECRET: "mysecret",
            SCHEMA_REGISTRY_API_KEY: undefined,
            SCHEMA_REGISTRY_API_SECRET: undefined,
          }),
        ).toThrow(/KAFKA_API_KEY/);
      });

      it("should throw when SCHEMA_REGISTRY_API_KEY is set but SCHEMA_REGISTRY_API_SECRET is missing", () => {
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: undefined,
            SCHEMA_REGISTRY_ENDPOINT: "https://sr.example.com",
            KAFKA_API_KEY: undefined,
            KAFKA_API_SECRET: undefined,
            SCHEMA_REGISTRY_API_KEY: "srkey",
            SCHEMA_REGISTRY_API_SECRET: undefined,
          }),
        ).toThrow(/SCHEMA_REGISTRY_API_SECRET/);
      });

      it("should throw when SCHEMA_REGISTRY_API_SECRET is set but SCHEMA_REGISTRY_API_KEY is missing", () => {
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: undefined,
            SCHEMA_REGISTRY_ENDPOINT: "https://sr.example.com",
            KAFKA_API_KEY: undefined,
            KAFKA_API_SECRET: undefined,
            SCHEMA_REGISTRY_API_KEY: undefined,
            SCHEMA_REGISTRY_API_SECRET: "srsecret",
          }),
        ).toThrow(/SCHEMA_REGISTRY_API_KEY/);
      });
    });

    describe("auth credentials without corresponding endpoint (misconfiguration)", () => {
      it("should throw when Kafka auth is set but BOOTSTRAP_SERVERS is absent", () => {
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: undefined,
            SCHEMA_REGISTRY_ENDPOINT: undefined,
            KAFKA_API_KEY: "mykey",
            KAFKA_API_SECRET: "mysecret",
            SCHEMA_REGISTRY_API_KEY: undefined,
            SCHEMA_REGISTRY_API_SECRET: undefined,
          }),
        ).toThrow(/BOOTSTRAP_SERVERS/);
      });

      it("should throw when SR auth is set but SCHEMA_REGISTRY_ENDPOINT is absent", () => {
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: undefined,
            SCHEMA_REGISTRY_ENDPOINT: undefined,
            KAFKA_API_KEY: undefined,
            KAFKA_API_SECRET: undefined,
            SCHEMA_REGISTRY_API_KEY: "srkey",
            SCHEMA_REGISTRY_API_SECRET: "srsecret",
          }),
        ).toThrow(/SCHEMA_REGISTRY_ENDPOINT/);
      });
    });
  });
});
