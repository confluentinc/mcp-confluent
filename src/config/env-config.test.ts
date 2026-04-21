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
          /At least one of 'kafka', 'schema_registry', 'confluent_cloud', or 'tableflow' must be defined/,
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
            CONFLUENT_CLOUD_REST_ENDPOINT: undefined,
            CONFLUENT_CLOUD_API_KEY: undefined,
            CONFLUENT_CLOUD_API_SECRET: undefined,
            TABLEFLOW_API_KEY: undefined,
            TABLEFLOW_API_SECRET: undefined,
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
            CONFLUENT_CLOUD_REST_ENDPOINT: undefined,
            CONFLUENT_CLOUD_API_KEY: undefined,
            CONFLUENT_CLOUD_API_SECRET: undefined,
            TABLEFLOW_API_KEY: undefined,
            TABLEFLOW_API_SECRET: undefined,
          }),
        ).toThrow(/SCHEMA_REGISTRY_ENDPOINT/);
      });
    });

    describe("confluent_cloud env vars", () => {
      it("should populate confluent_cloud auth when key and secret are set", () => {
        const config = consConfigFromEnv({
          BOOTSTRAP_SERVERS: undefined,
          SCHEMA_REGISTRY_ENDPOINT: undefined,
          KAFKA_API_KEY: undefined,
          KAFKA_API_SECRET: undefined,
          SCHEMA_REGISTRY_API_KEY: undefined,
          SCHEMA_REGISTRY_API_SECRET: undefined,
          CONFLUENT_CLOUD_REST_ENDPOINT: undefined,
          CONFLUENT_CLOUD_API_KEY: "cckey",
          CONFLUENT_CLOUD_API_SECRET: "ccsecret",
          TABLEFLOW_API_KEY: undefined,
          TABLEFLOW_API_SECRET: undefined,
        });
        const conn = config.getSoleConnection();
        expect(conn.confluent_cloud?.auth).toEqual({
          type: "api_key",
          key: "cckey",
          secret: "ccsecret",
        });
        expect(conn.confluent_cloud?.endpoint).toBeUndefined();
      });

      it("should populate confluent_cloud endpoint when only CONFLUENT_CLOUD_REST_ENDPOINT is set", () => {
        const config = consConfigFromEnv({
          BOOTSTRAP_SERVERS: undefined,
          SCHEMA_REGISTRY_ENDPOINT: undefined,
          KAFKA_API_KEY: undefined,
          KAFKA_API_SECRET: undefined,
          SCHEMA_REGISTRY_API_KEY: undefined,
          SCHEMA_REGISTRY_API_SECRET: undefined,
          CONFLUENT_CLOUD_REST_ENDPOINT: "https://custom.confluent.cloud",
          CONFLUENT_CLOUD_API_KEY: undefined,
          CONFLUENT_CLOUD_API_SECRET: undefined,
          TABLEFLOW_API_KEY: undefined,
          TABLEFLOW_API_SECRET: undefined,
        });
        const conn = config.getSoleConnection();
        expect(conn.confluent_cloud?.endpoint).toBe(
          "https://custom.confluent.cloud",
        );
        expect(conn.confluent_cloud?.auth).toBeUndefined();
      });

      it("should populate both endpoint and auth when all three CCloud vars are set", () => {
        const config = consConfigFromEnv({
          BOOTSTRAP_SERVERS: undefined,
          SCHEMA_REGISTRY_ENDPOINT: undefined,
          KAFKA_API_KEY: undefined,
          KAFKA_API_SECRET: undefined,
          SCHEMA_REGISTRY_API_KEY: undefined,
          SCHEMA_REGISTRY_API_SECRET: undefined,
          CONFLUENT_CLOUD_REST_ENDPOINT: "https://custom.confluent.cloud",
          CONFLUENT_CLOUD_API_KEY: "cckey",
          CONFLUENT_CLOUD_API_SECRET: "ccsecret",
          TABLEFLOW_API_KEY: undefined,
          TABLEFLOW_API_SECRET: undefined,
        });
        const conn = config.getSoleConnection();
        expect(conn.confluent_cloud?.endpoint).toBe(
          "https://custom.confluent.cloud",
        );
        expect(conn.confluent_cloud?.auth).toEqual({
          type: "api_key",
          key: "cckey",
          secret: "ccsecret",
        });
      });

      it("should be valid as a standalone block (no kafka or schema_registry)", () => {
        const config = consConfigFromEnv({
          BOOTSTRAP_SERVERS: undefined,
          SCHEMA_REGISTRY_ENDPOINT: undefined,
          KAFKA_API_KEY: undefined,
          KAFKA_API_SECRET: undefined,
          SCHEMA_REGISTRY_API_KEY: undefined,
          SCHEMA_REGISTRY_API_SECRET: undefined,
          CONFLUENT_CLOUD_REST_ENDPOINT: undefined,
          CONFLUENT_CLOUD_API_KEY: "cckey",
          CONFLUENT_CLOUD_API_SECRET: "ccsecret",
          TABLEFLOW_API_KEY: undefined,
          TABLEFLOW_API_SECRET: undefined,
        });
        const conn = config.getSoleConnection();
        expect(conn.confluent_cloud?.auth).toBeDefined();
        expect(conn.kafka).toBeUndefined();
        expect(conn.schema_registry).toBeUndefined();
      });

      it("should throw when CONFLUENT_CLOUD_API_KEY is set but CONFLUENT_CLOUD_API_SECRET is missing", () => {
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: undefined,
            SCHEMA_REGISTRY_ENDPOINT: undefined,
            KAFKA_API_KEY: undefined,
            KAFKA_API_SECRET: undefined,
            SCHEMA_REGISTRY_API_KEY: undefined,
            SCHEMA_REGISTRY_API_SECRET: undefined,
            CONFLUENT_CLOUD_REST_ENDPOINT: undefined,
            CONFLUENT_CLOUD_API_KEY: "cckey",
            CONFLUENT_CLOUD_API_SECRET: undefined,
            TABLEFLOW_API_KEY: undefined,
            TABLEFLOW_API_SECRET: undefined,
          }),
        ).toThrow(/CONFLUENT_CLOUD_API_SECRET/);
      });

      it("should throw when CONFLUENT_CLOUD_API_SECRET is set but CONFLUENT_CLOUD_API_KEY is missing", () => {
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: undefined,
            SCHEMA_REGISTRY_ENDPOINT: undefined,
            KAFKA_API_KEY: undefined,
            KAFKA_API_SECRET: undefined,
            SCHEMA_REGISTRY_API_KEY: undefined,
            SCHEMA_REGISTRY_API_SECRET: undefined,
            CONFLUENT_CLOUD_REST_ENDPOINT: undefined,
            CONFLUENT_CLOUD_API_KEY: undefined,
            CONFLUENT_CLOUD_API_SECRET: "ccsecret",
            TABLEFLOW_API_KEY: undefined,
            TABLEFLOW_API_SECRET: undefined,
          }),
        ).toThrow(/CONFLUENT_CLOUD_API_KEY/);
      });
    });

    describe("tableflow env vars", () => {
      it("should populate tableflow auth when key and secret are set", () => {
        const config = consConfigFromEnv({
          BOOTSTRAP_SERVERS: undefined,
          SCHEMA_REGISTRY_ENDPOINT: undefined,
          KAFKA_API_KEY: undefined,
          KAFKA_API_SECRET: undefined,
          SCHEMA_REGISTRY_API_KEY: undefined,
          SCHEMA_REGISTRY_API_SECRET: undefined,
          CONFLUENT_CLOUD_REST_ENDPOINT: undefined,
          CONFLUENT_CLOUD_API_KEY: undefined,
          CONFLUENT_CLOUD_API_SECRET: undefined,
          TABLEFLOW_API_KEY: "tfkey",
          TABLEFLOW_API_SECRET: "tfsecret",
        });
        const conn = config.getSoleConnection();
        expect(conn.tableflow?.auth).toEqual({
          type: "api_key",
          key: "tfkey",
          secret: "tfsecret",
        });
      });

      it("should be valid as a standalone block (no kafka, sr, or confluent_cloud)", () => {
        const config = consConfigFromEnv({
          BOOTSTRAP_SERVERS: undefined,
          SCHEMA_REGISTRY_ENDPOINT: undefined,
          KAFKA_API_KEY: undefined,
          KAFKA_API_SECRET: undefined,
          SCHEMA_REGISTRY_API_KEY: undefined,
          SCHEMA_REGISTRY_API_SECRET: undefined,
          CONFLUENT_CLOUD_REST_ENDPOINT: undefined,
          CONFLUENT_CLOUD_API_KEY: undefined,
          CONFLUENT_CLOUD_API_SECRET: undefined,
          TABLEFLOW_API_KEY: "tfkey",
          TABLEFLOW_API_SECRET: "tfsecret",
        });
        const conn = config.getSoleConnection();
        expect(conn.tableflow?.auth).toBeDefined();
        expect(conn.kafka).toBeUndefined();
        expect(conn.schema_registry).toBeUndefined();
        expect(conn.confluent_cloud).toBeUndefined();
      });

      it("should throw when TABLEFLOW_API_KEY is set but TABLEFLOW_API_SECRET is missing", () => {
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: undefined,
            SCHEMA_REGISTRY_ENDPOINT: undefined,
            KAFKA_API_KEY: undefined,
            KAFKA_API_SECRET: undefined,
            SCHEMA_REGISTRY_API_KEY: undefined,
            SCHEMA_REGISTRY_API_SECRET: undefined,
            CONFLUENT_CLOUD_REST_ENDPOINT: undefined,
            CONFLUENT_CLOUD_API_KEY: undefined,
            CONFLUENT_CLOUD_API_SECRET: undefined,
            TABLEFLOW_API_KEY: "tfkey",
            TABLEFLOW_API_SECRET: undefined,
          }),
        ).toThrow(/TABLEFLOW_API_SECRET/);
      });

      it("should throw when TABLEFLOW_API_SECRET is set but TABLEFLOW_API_KEY is missing", () => {
        expect(() =>
          consConfigFromEnv({
            BOOTSTRAP_SERVERS: undefined,
            SCHEMA_REGISTRY_ENDPOINT: undefined,
            KAFKA_API_KEY: undefined,
            KAFKA_API_SECRET: undefined,
            SCHEMA_REGISTRY_API_KEY: undefined,
            SCHEMA_REGISTRY_API_SECRET: undefined,
            CONFLUENT_CLOUD_REST_ENDPOINT: undefined,
            CONFLUENT_CLOUD_API_KEY: undefined,
            CONFLUENT_CLOUD_API_SECRET: undefined,
            TABLEFLOW_API_KEY: undefined,
            TABLEFLOW_API_SECRET: "tfsecret",
          }),
        ).toThrow(/TABLEFLOW_API_KEY/);
      });
    });
  });
});
