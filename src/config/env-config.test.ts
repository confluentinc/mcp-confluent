import { buildConfigFromEnvAndCli } from "@src/config/env-config.js";
import { describe, expect, it } from "vitest";

type EnvInput = Parameters<typeof buildConfigFromEnvAndCli>[0];

/** Returns a fully-populated env object with connection vars undefined and server vars at envSchema defaults, overridden by the provided values. */
function envWith(overrides: Partial<EnvInput> = {}): EnvInput {
  return {
    // Connection vars — all optional, so undefined is valid
    BOOTSTRAP_SERVERS: undefined,
    KAFKA_API_KEY: undefined,
    KAFKA_API_SECRET: undefined,
    KAFKA_REST_ENDPOINT: undefined,
    KAFKA_CLUSTER_ID: undefined,
    KAFKA_ENV_ID: undefined,
    SCHEMA_REGISTRY_ENDPOINT: undefined,
    SCHEMA_REGISTRY_API_KEY: undefined,
    SCHEMA_REGISTRY_API_SECRET: undefined,
    CONFLUENT_CLOUD_REST_ENDPOINT: undefined,
    CONFLUENT_CLOUD_API_KEY: undefined,
    CONFLUENT_CLOUD_API_SECRET: undefined,
    TABLEFLOW_API_KEY: undefined,
    TABLEFLOW_API_SECRET: undefined,
    FLINK_REST_ENDPOINT: undefined,
    FLINK_API_KEY: undefined,
    FLINK_API_SECRET: undefined,
    FLINK_ENV_ID: undefined,
    FLINK_ORG_ID: undefined,
    FLINK_COMPUTE_POOL_ID: undefined,
    FLINK_ENV_NAME: undefined,
    FLINK_DATABASE_NAME: undefined,
    TELEMETRY_ENDPOINT: undefined,
    TELEMETRY_API_KEY: undefined,
    TELEMETRY_API_SECRET: undefined,
    // Server vars — non-optional in Environment (have envSchema defaults), so must be provided
    LOG_LEVEL: "info",
    HTTP_PORT: 8080,
    HTTP_HOST: "127.0.0.1",
    HTTP_MCP_ENDPOINT_PATH: "/mcp",
    SSE_MCP_ENDPOINT_PATH: "/sse",
    SSE_MCP_MESSAGE_ENDPOINT_PATH: "/messages",
    MCP_API_KEY: undefined,
    MCP_AUTH_DISABLED: false,
    MCP_ALLOWED_HOSTS: ["localhost", "127.0.0.1"],
    DO_NOT_TRACK: false,
    ...overrides,
  };
}

describe("config/env-config.ts", () => {
  describe("buildConfigFromEnvAndCli", () => {
    describe("most minimal configurations --- only (BOOTSTRAP_SERVERS and/or SCHEMA_REGISTRY_ENDPOINT) set", () => {
      it("should build a config with both kafka and schema_registry when both env vars are set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "localhost:9092",
            SCHEMA_REGISTRY_ENDPOINT: "http://localhost:8081",
          }),
        );

        const conn = config.getSoleConnection();
        expect(conn.type).toBe("direct");
        expect(conn.kafka?.bootstrap_servers).toBe("localhost:9092");
        expect(conn.schema_registry?.endpoint).toBe("http://localhost:8081");
      });

      it("should use 'env-connection' as the connection name", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({ BOOTSTRAP_SERVERS: "localhost:9092" }),
        );

        expect(Object.keys(config.connections)).toEqual(["env-connection"]);
      });

      it("should build a kafka-only config when only BOOTSTRAP_SERVERS is set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({ BOOTSTRAP_SERVERS: "broker1:9092,broker2:9092" }),
        );

        const conn = config.getSoleConnection();
        expect(conn.kafka?.bootstrap_servers).toBe("broker1:9092,broker2:9092");
        expect(conn.schema_registry).toBeUndefined();
      });

      it("should build a schema_registry-only config when only SCHEMA_REGISTRY_ENDPOINT is set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({ SCHEMA_REGISTRY_ENDPOINT: "https://sr.example.com:8081" }),
        );

        const conn = config.getSoleConnection();
        expect(conn.schema_registry?.endpoint).toBe(
          "https://sr.example.com:8081",
        );
        expect(conn.kafka).toBeUndefined();
      });

      it("should throw when neither env var is set", () => {
        expect(() => buildConfigFromEnvAndCli(envWith())).toThrow(
          /Failed to construct MCPServerConfiguration from environment variables/,
        );
        expect(() => buildConfigFromEnvAndCli(envWith())).toThrow(
          /At least one of 'kafka', 'schema_registry', 'confluent_cloud', 'tableflow', 'flink', or 'telemetry' must be defined/,
        );
      });

      it("should throw when BOOTSTRAP_SERVERS has an invalid format", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({ BOOTSTRAP_SERVERS: "invalid-no-port" }),
          ),
        ).toThrow(
          /Failed to construct MCPServerConfiguration from environment variables/,
        );
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({ BOOTSTRAP_SERVERS: "invalid-no-port" }),
          ),
        ).toThrow(/Invalid format 'invalid-no-port': must be host:port/);
      });
    });

    describe("with auth env vars", () => {
      it("should populate kafka auth when both KAFKA_API_KEY and KAFKA_API_SECRET are set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "localhost:9092",
            KAFKA_API_KEY: "mykey",
            KAFKA_API_SECRET: "mysecret",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.kafka?.auth).toEqual({
          type: "api_key",
          key: "mykey",
          secret: "mysecret",
        });
      });

      it("should populate schema_registry auth when both SR vars are set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            SCHEMA_REGISTRY_ENDPOINT: "https://sr.example.com",
            SCHEMA_REGISTRY_API_KEY: "srkey",
            SCHEMA_REGISTRY_API_SECRET: "srsecret",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.schema_registry?.auth).toEqual({
          type: "api_key",
          key: "srkey",
          secret: "srsecret",
        });
      });

      it("should populate auth on both sides when all four auth vars are set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "localhost:9092",
            SCHEMA_REGISTRY_ENDPOINT: "https://sr.example.com",
            KAFKA_API_KEY: "kafkakey",
            KAFKA_API_SECRET: "kafkasecret",
            SCHEMA_REGISTRY_API_KEY: "srkey",
            SCHEMA_REGISTRY_API_SECRET: "srsecret",
          }),
        );
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
          buildConfigFromEnvAndCli(
            envWith({
              BOOTSTRAP_SERVERS: "localhost:9092",
              KAFKA_API_KEY: "mykey",
            }),
          ),
        ).toThrow(/KAFKA_API_SECRET/);
      });

      it("should throw when KAFKA_API_SECRET is set but KAFKA_API_KEY is missing", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({
              BOOTSTRAP_SERVERS: "localhost:9092",
              KAFKA_API_SECRET: "mysecret",
            }),
          ),
        ).toThrow(/KAFKA_API_KEY/);
      });

      it("should throw when SCHEMA_REGISTRY_API_KEY is set but SCHEMA_REGISTRY_API_SECRET is missing", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({
              SCHEMA_REGISTRY_ENDPOINT: "https://sr.example.com",
              SCHEMA_REGISTRY_API_KEY: "srkey",
            }),
          ),
        ).toThrow(/SCHEMA_REGISTRY_API_SECRET/);
      });

      it("should throw when SCHEMA_REGISTRY_API_SECRET is set but SCHEMA_REGISTRY_API_KEY is missing", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({
              SCHEMA_REGISTRY_ENDPOINT: "https://sr.example.com",
              SCHEMA_REGISTRY_API_SECRET: "srsecret",
            }),
          ),
        ).toThrow(/SCHEMA_REGISTRY_API_KEY/);
      });
    });

    describe("auth credentials without corresponding endpoint (misconfiguration)", () => {
      it("should throw when Kafka auth is set but BOOTSTRAP_SERVERS is absent", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({ KAFKA_API_KEY: "mykey", KAFKA_API_SECRET: "mysecret" }),
          ),
        ).toThrow(
          /kafka block must contain at least one of 'bootstrap_servers' or 'rest_endpoint'/,
        );
      });

      it("should throw when SR auth is set but SCHEMA_REGISTRY_ENDPOINT is absent", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({
              SCHEMA_REGISTRY_API_KEY: "srkey",
              SCHEMA_REGISTRY_API_SECRET: "srsecret",
            }),
          ),
        ).toThrow(/SCHEMA_REGISTRY_ENDPOINT/);
      });
    });

    describe("confluent_cloud env vars", () => {
      it("should populate confluent_cloud auth when key and secret are set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            CONFLUENT_CLOUD_API_KEY: "cckey",
            CONFLUENT_CLOUD_API_SECRET: "ccsecret",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.confluent_cloud?.auth).toEqual({
          type: "api_key",
          key: "cckey",
          secret: "ccsecret",
        });
        expect(conn.confluent_cloud?.endpoint).toBe(
          "https://api.confluent.cloud",
        );
      });

      it("should omit confluent_cloud block when endpoint is set without credentials", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "broker:9092",
            CONFLUENT_CLOUD_REST_ENDPOINT: "https://custom.confluent.cloud",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.confluent_cloud).toBeUndefined();
      });

      it("should populate both endpoint and auth when all three CCloud vars are set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            CONFLUENT_CLOUD_REST_ENDPOINT: "https://custom.confluent.cloud",
            CONFLUENT_CLOUD_API_KEY: "cckey",
            CONFLUENT_CLOUD_API_SECRET: "ccsecret",
          }),
        );
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
        const config = buildConfigFromEnvAndCli(
          envWith({
            CONFLUENT_CLOUD_API_KEY: "cckey",
            CONFLUENT_CLOUD_API_SECRET: "ccsecret",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.confluent_cloud?.auth).toBeDefined();
        expect(conn.kafka).toBeUndefined();
        expect(conn.schema_registry).toBeUndefined();
      });

      it("should throw when CONFLUENT_CLOUD_API_KEY is set but CONFLUENT_CLOUD_API_SECRET is missing", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({ CONFLUENT_CLOUD_API_KEY: "cckey" }),
          ),
        ).toThrow(/CONFLUENT_CLOUD_API_SECRET/);
      });

      it("should throw when CONFLUENT_CLOUD_API_SECRET is set but CONFLUENT_CLOUD_API_KEY is missing", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({ CONFLUENT_CLOUD_API_SECRET: "ccsecret" }),
          ),
        ).toThrow(/CONFLUENT_CLOUD_API_KEY/);
      });
    });

    describe("flink env vars", () => {
      const allRequiredFlinkEnvVars = {
        FLINK_REST_ENDPOINT: "https://flink.us-east-1.aws.confluent.cloud",
        FLINK_API_KEY: "flinkkey",
        FLINK_API_SECRET: "flinksecret",
        FLINK_ENV_ID: "env-abc123",
        FLINK_ORG_ID: "org-xyz789",
        FLINK_COMPUTE_POOL_ID: "lfcp-pool01",
      } as const;

      it("should populate flink block when all required fields are set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith(allRequiredFlinkEnvVars),
        );
        const conn = config.getSoleConnection();
        expect(conn.flink?.endpoint).toBe(
          "https://flink.us-east-1.aws.confluent.cloud",
        );
        expect(conn.flink?.auth).toEqual({
          type: "api_key",
          key: "flinkkey",
          secret: "flinksecret",
        });
        expect(conn.flink?.environment_id).toBe("env-abc123");
        expect(conn.flink?.organization_id).toBe("org-xyz789");
        expect(conn.flink?.compute_pool_id).toBe("lfcp-pool01");
      });

      it("should populate all optional fields when provided", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            ...allRequiredFlinkEnvVars,
            FLINK_ENV_NAME: "my-environment",
            FLINK_DATABASE_NAME: "my-cluster",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.flink?.environment_name).toBe("my-environment");
        expect(conn.flink?.database_name).toBe("my-cluster");
      });

      it("should be valid as a standalone block (no kafka, sr, confluent_cloud, or tableflow)", () => {
        const config = buildConfigFromEnvAndCli(
          envWith(allRequiredFlinkEnvVars),
        );
        const conn = config.getSoleConnection();
        expect(conn.flink).toBeDefined();
        expect(conn.kafka).toBeUndefined();
        expect(conn.schema_registry).toBeUndefined();
        expect(conn.confluent_cloud).toBeUndefined();
        expect(conn.tableflow).toBeUndefined();
      });

      it("should throw when FLINK_API_KEY is set but FLINK_API_SECRET is missing", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({
              ...allRequiredFlinkEnvVars,
              FLINK_API_SECRET: undefined,
            }),
          ),
        ).toThrow(/FLINK_API_SECRET/);
      });

      it("should throw when FLINK_API_SECRET is set but FLINK_API_KEY is missing", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({ ...allRequiredFlinkEnvVars, FLINK_API_KEY: undefined }),
          ),
        ).toThrow(/FLINK_API_KEY/);
      });

      it("should throw when flink block is triggered but required fields are missing", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({
              FLINK_REST_ENDPOINT:
                "https://flink.us-east-1.aws.confluent.cloud",
            }),
          ),
        ).toThrow(/FLINK_ENV_ID/);
      });
    });

    describe("kafka REST metadata env vars", () => {
      it("should populate kafka.rest_endpoint when KAFKA_REST_ENDPOINT is set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "broker.confluent.cloud:9092",
            KAFKA_REST_ENDPOINT:
              "https://pkc-abc123.us-east-1.aws.confluent.cloud:443",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.kafka?.rest_endpoint).toBe(
          "https://pkc-abc123.us-east-1.aws.confluent.cloud:443",
        );
      });

      it("should populate kafka.cluster_id when KAFKA_CLUSTER_ID is set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "broker.confluent.cloud:9092",
            KAFKA_CLUSTER_ID: "lkc-abc123",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.kafka?.cluster_id).toBe("lkc-abc123");
      });

      it("should populate kafka.env_id when KAFKA_ENV_ID is set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "broker.confluent.cloud:9092",
            KAFKA_ENV_ID: "env-xyz789",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.kafka?.env_id).toBe("env-xyz789");
      });

      it("should populate all three metadata fields together", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "broker.confluent.cloud:9092",
            KAFKA_REST_ENDPOINT:
              "https://pkc-abc123.us-east-1.aws.confluent.cloud:443",
            KAFKA_CLUSTER_ID: "lkc-abc123",
            KAFKA_ENV_ID: "env-xyz789",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.kafka?.rest_endpoint).toBe(
          "https://pkc-abc123.us-east-1.aws.confluent.cloud:443",
        );
        expect(conn.kafka?.cluster_id).toBe("lkc-abc123");
        expect(conn.kafka?.env_id).toBe("env-xyz789");
      });

      it("should throw when KAFKA_ENV_ID lacks the env- prefix", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({
              BOOTSTRAP_SERVERS: "broker.confluent.cloud:9092",
              KAFKA_ENV_ID: "bad-id",
            }),
          ),
        ).toThrow(/KAFKA_ENV_ID/);
      });

      it("should trigger kafka block from KAFKA_REST_ENDPOINT alone (no BOOTSTRAP_SERVERS)", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            KAFKA_REST_ENDPOINT:
              "https://pkc-abc123.us-east-1.aws.confluent.cloud:443",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.kafka?.rest_endpoint).toBe(
          "https://pkc-abc123.us-east-1.aws.confluent.cloud:443",
        );
        expect(conn.kafka?.bootstrap_servers).toBeUndefined();
      });
    });

    describe("tableflow env vars", () => {
      it("should populate tableflow auth when key and secret are set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            TABLEFLOW_API_KEY: "tfkey",
            TABLEFLOW_API_SECRET: "tfsecret",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.tableflow?.auth).toEqual({
          type: "api_key",
          key: "tfkey",
          secret: "tfsecret",
        });
      });

      it("should be valid as a standalone block (no kafka, sr, or confluent_cloud)", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            TABLEFLOW_API_KEY: "tfkey",
            TABLEFLOW_API_SECRET: "tfsecret",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.tableflow?.auth).toBeDefined();
        expect(conn.kafka).toBeUndefined();
        expect(conn.schema_registry).toBeUndefined();
        expect(conn.confluent_cloud).toBeUndefined();
      });

      it("should throw when TABLEFLOW_API_KEY is set but TABLEFLOW_API_SECRET is missing", () => {
        expect(() =>
          buildConfigFromEnvAndCli(envWith({ TABLEFLOW_API_KEY: "tfkey" })),
        ).toThrow(/TABLEFLOW_API_SECRET/);
      });

      it("should throw when TABLEFLOW_API_SECRET is set but TABLEFLOW_API_KEY is missing", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({ TABLEFLOW_API_SECRET: "tfsecret" }),
          ),
        ).toThrow(/TABLEFLOW_API_KEY/);
      });
    });

    describe("server block env vars", () => {
      it("should populate server.log_level from LOG_LEVEL", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({ BOOTSTRAP_SERVERS: "localhost:9092", LOG_LEVEL: "debug" }),
        );
        expect(config.server.log_level).toBe("debug");
      });

      it("should populate server.http.port from HTTP_PORT", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({ BOOTSTRAP_SERVERS: "localhost:9092", HTTP_PORT: 9090 }),
        );
        expect(config.server.http.port).toBe(9090);
      });

      it("should populate server.http.host from HTTP_HOST", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "localhost:9092",
            HTTP_HOST: "0.0.0.0",
          }),
        );
        expect(config.server.http.host).toBe("0.0.0.0");
      });

      it("should populate server.http.mcp_endpoint from HTTP_MCP_ENDPOINT_PATH", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "localhost:9092",
            HTTP_MCP_ENDPOINT_PATH: "/custom-mcp",
          }),
        );
        expect(config.server.http.mcp_endpoint).toBe("/custom-mcp");
      });

      it("should populate server.http.sse_endpoint from SSE_MCP_ENDPOINT_PATH", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "localhost:9092",
            SSE_MCP_ENDPOINT_PATH: "/custom-sse",
          }),
        );
        expect(config.server.http.sse_endpoint).toBe("/custom-sse");
      });

      it("should populate server.http.sse_message_endpoint from SSE_MCP_MESSAGE_ENDPOINT_PATH", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "localhost:9092",
            SSE_MCP_MESSAGE_ENDPOINT_PATH: "/custom-messages",
          }),
        );
        expect(config.server.http.sse_message_endpoint).toBe(
          "/custom-messages",
        );
      });

      it("should populate server.auth.api_key from MCP_API_KEY when set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "localhost:9092",
            MCP_API_KEY: "a".repeat(32),
          }),
        );
        expect(config.server.auth.api_key).toBe("a".repeat(32));
      });

      it("should leave server.auth.api_key undefined when MCP_API_KEY is not set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({ BOOTSTRAP_SERVERS: "localhost:9092" }),
        );
        expect(config.server.auth.api_key).toBeUndefined();
      });

      it("should populate server.auth.disabled from MCP_AUTH_DISABLED", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "localhost:9092",
            MCP_AUTH_DISABLED: true,
          }),
        );
        expect(config.server.auth.disabled).toBe(true);
      });

      it("should populate server.auth.allowed_hosts from MCP_ALLOWED_HOSTS", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "localhost:9092",
            MCP_ALLOWED_HOSTS: ["example.com", "api.example.com"],
          }),
        );
        expect(config.server.auth.allowed_hosts).toEqual([
          "example.com",
          "api.example.com",
        ]);
      });

      it("should reflect envSchema defaults when no server vars are overridden", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({ BOOTSTRAP_SERVERS: "localhost:9092" }),
        );
        expect(config.server.log_level).toBe("info");
        expect(config.server.http.port).toBe(8080);
        expect(config.server.http.host).toBe("127.0.0.1");
        expect(config.server.http.mcp_endpoint).toBe("/mcp");
        expect(config.server.http.sse_endpoint).toBe("/sse");
        expect(config.server.http.sse_message_endpoint).toBe("/messages");
        expect(config.server.auth.disabled).toBe(false);
        expect(config.server.auth.allowed_hosts).toEqual([
          "localhost",
          "127.0.0.1",
        ]);
      });

      it("should throw when MCP_AUTH_DISABLED:true and MCP_API_KEY are both set", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({
              BOOTSTRAP_SERVERS: "localhost:9092",
              MCP_AUTH_DISABLED: true,
              MCP_API_KEY: "a".repeat(32),
            }),
          ),
        ).toThrow(
          /Failed to construct MCPServerConfiguration from environment variables/,
        );
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({
              BOOTSTRAP_SERVERS: "localhost:9092",
              MCP_AUTH_DISABLED: true,
              MCP_API_KEY: "a".repeat(32),
            }),
          ),
        ).toThrow(/MCP_AUTH_DISABLED.*MCP_API_KEY/);
      });

      it("should throw when MCP_API_KEY is shorter than 32 characters, with error mentioning MCP_API_KEY", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({
              BOOTSTRAP_SERVERS: "localhost:9092",
              MCP_API_KEY: "short",
            }),
          ),
        ).toThrow(/MCP_API_KEY.*32/);
      });

      it("should populate server.do_not_track from DO_NOT_TRACK", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({ BOOTSTRAP_SERVERS: "localhost:9092", DO_NOT_TRACK: true }),
        );
        expect(config.server.do_not_track).toBe(true);
      });

      it("should default server.do_not_track to false when DO_NOT_TRACK is not set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({ BOOTSTRAP_SERVERS: "localhost:9092" }),
        );
        expect(config.server.do_not_track).toBe(false);
      });

      it("should leave server.transports at the schema default [stdio] on the env-var path", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({ BOOTSTRAP_SERVERS: "localhost:9092" }),
        );
        expect(config.server.transports).toEqual(["stdio"]);
      });
    });

    describe("telemetry env vars", () => {
      it("should populate both endpoint and auth when all three telemetry vars are set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            TELEMETRY_ENDPOINT: "https://custom.telemetry.confluent.cloud",
            TELEMETRY_API_KEY: "telkey",
            TELEMETRY_API_SECRET: "telsecret",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.telemetry).toEqual({
          endpoint: "https://custom.telemetry.confluent.cloud",
          auth: { type: "api_key", key: "telkey", secret: "telsecret" },
        });
      });

      it("should populate telemetry auth and resolve default endpoint when key and secret are set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            TELEMETRY_API_KEY: "telkey",
            TELEMETRY_API_SECRET: "telsecret",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.telemetry).toEqual({
          endpoint: "https://api.telemetry.confluent.cloud",
          auth: { type: "api_key", key: "telkey", secret: "telsecret" },
        });
      });

      it("should throw when TELEMETRY_ENDPOINT is set but no auth is available, with error mentioning TELEMETRY_ENDPOINT", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({
              TELEMETRY_ENDPOINT: "https://custom.telemetry.confluent.cloud",
            }),
          ),
        ).toThrow(/TELEMETRY_ENDPOINT.*no auth is available/);
      });

      it("should use confluent_cloud.auth when only TELEMETRY_ENDPOINT and cc credentials are set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            TELEMETRY_ENDPOINT: "https://custom.telemetry.confluent.cloud",
            CONFLUENT_CLOUD_API_KEY: "cckey",
            CONFLUENT_CLOUD_API_SECRET: "ccsecret",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.telemetry).toEqual({
          endpoint: "https://custom.telemetry.confluent.cloud",
          auth: { type: "api_key", key: "cckey", secret: "ccsecret" },
        });
      });

      it("should synthesize telemetry from confluent_cloud.auth when no TELEMETRY_* vars are set", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            CONFLUENT_CLOUD_API_KEY: "cckey",
            CONFLUENT_CLOUD_API_SECRET: "ccsecret",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.telemetry).toEqual({
          endpoint: "https://api.telemetry.confluent.cloud",
          auth: { type: "api_key", key: "cckey", secret: "ccsecret" },
        });
      });

      it("should be valid as a standalone block (no kafka, sr, confluent_cloud, tableflow, or flink)", () => {
        const config = buildConfigFromEnvAndCli(
          envWith({
            TELEMETRY_API_KEY: "telkey",
            TELEMETRY_API_SECRET: "telsecret",
          }),
        );
        const conn = config.getSoleConnection();
        expect(conn.telemetry?.endpoint).toBe(
          "https://api.telemetry.confluent.cloud",
        );
        expect(conn.telemetry?.auth).toEqual({
          type: "api_key",
          key: "telkey",
          secret: "telsecret",
        });
        expect(conn.kafka).toBeUndefined();
        expect(conn.schema_registry).toBeUndefined();
        expect(conn.confluent_cloud).toBeUndefined();
        expect(conn.tableflow).toBeUndefined();
        expect(conn.flink).toBeUndefined();
      });

      it("should throw when TELEMETRY_API_KEY is set but TELEMETRY_API_SECRET is missing", () => {
        expect(() =>
          buildConfigFromEnvAndCli(envWith({ TELEMETRY_API_KEY: "telkey" })),
        ).toThrow(/TELEMETRY_API_SECRET/);
      });

      it("should throw when TELEMETRY_API_SECRET is set but TELEMETRY_API_KEY is missing", () => {
        expect(() =>
          buildConfigFromEnvAndCli(
            envWith({ TELEMETRY_API_SECRET: "telsecret" }),
          ),
        ).toThrow(/TELEMETRY_API_KEY/);
      });
    });
  });

  describe("buildConfigFromEnvAndCli", () => {
    it("should produce the same result as calling with no overrides as with env vars only", () => {
      const config = buildConfigFromEnvAndCli(
        envWith({ BOOTSTRAP_SERVERS: "localhost:9092" }),
      );
      expect(config.server.auth.disabled).toBe(false);
      expect(config.server.auth.allowed_hosts).toEqual([
        "localhost",
        "127.0.0.1",
      ]);
      expect(config.getSoleConnection().kafka?.bootstrap_servers).toBe(
        "localhost:9092",
      );
    });

    it("should override server.auth.disabled when disableAuth: true is provided", () => {
      const config = buildConfigFromEnvAndCli(
        envWith({ BOOTSTRAP_SERVERS: "localhost:9092" }),
        { disableAuth: true },
      );
      expect(config.server.auth.disabled).toBe(true);
    });

    it("should leave server.auth.disabled false when disableAuth is not provided", () => {
      const config = buildConfigFromEnvAndCli(
        envWith({ BOOTSTRAP_SERVERS: "localhost:9092" }),
        {},
      );
      expect(config.server.auth.disabled).toBe(false);
    });

    it("should override server.auth.allowed_hosts when allowedHosts is provided", () => {
      const config = buildConfigFromEnvAndCli(
        envWith({ BOOTSTRAP_SERVERS: "localhost:9092" }),
        { allowedHosts: ["custom.host", "other.host"] },
      );
      expect(config.server.auth.allowed_hosts).toEqual([
        "custom.host",
        "other.host",
      ]);
    });

    it("should apply kafkaConfig extra properties to the connection", () => {
      const config = buildConfigFromEnvAndCli(
        envWith({ BOOTSTRAP_SERVERS: "localhost:9092" }),
        { kafkaConfig: { "ssl.ca.location": "/etc/ssl/certs/ca.pem" } },
      );
      expect(config.getSoleConnection().kafka?.extra_properties).toEqual({
        "ssl.ca.location": "/etc/ssl/certs/ca.pem",
      });
    });

    it("should apply kafkaConfig bootstrap.servers override to the connection", () => {
      const config = buildConfigFromEnvAndCli(
        envWith({ BOOTSTRAP_SERVERS: "original:9092" }),
        { kafkaConfig: { "bootstrap.servers": "override:9092" } },
      );
      expect(config.getSoleConnection().kafka?.bootstrap_servers).toBe(
        "override:9092",
      );
    });

    it("should construct a kafka block when none existed and kafkaConfig provides bootstrap.servers", () => {
      const config = buildConfigFromEnvAndCli(
        envWith({
          CONFLUENT_CLOUD_API_KEY: "k",
          CONFLUENT_CLOUD_API_SECRET: "s",
        }),
        { kafkaConfig: { "bootstrap.servers": "broker:9092" } },
      );
      expect(config.getSoleConnection().kafka?.bootstrap_servers).toBe(
        "broker:9092",
      );
      expect(
        config.getSoleConnection().kafka?.extra_properties,
      ).toBeUndefined();
    });

    it("should construct a kafka block with auth from sasl credentials when no kafka block existed", () => {
      const config = buildConfigFromEnvAndCli(
        envWith({
          CONFLUENT_CLOUD_API_KEY: "k",
          CONFLUENT_CLOUD_API_SECRET: "s",
        }),
        {
          kafkaConfig: {
            "bootstrap.servers": "broker:9092",
            "sasl.username": "mykey",
            "sasl.password": "mysecret",
          },
        },
      );
      const kafka = config.getSoleConnection().kafka;
      expect(kafka?.bootstrap_servers).toBe("broker:9092");
      expect(kafka?.auth).toEqual({
        type: "api_key",
        key: "mykey",
        secret: "mysecret",
      });
      expect(kafka?.extra_properties).toBeUndefined();
    });

    it("should put non-protected keys into extra_properties when constructing a kafka block from scratch", () => {
      const config = buildConfigFromEnvAndCli(
        envWith({
          CONFLUENT_CLOUD_API_KEY: "k",
          CONFLUENT_CLOUD_API_SECRET: "s",
        }),
        {
          kafkaConfig: {
            "bootstrap.servers": "broker:9092",
            "socket.timeout.ms": "30000",
          },
        },
      );
      const kafka = config.getSoleConnection().kafka;
      expect(kafka?.bootstrap_servers).toBe("broker:9092");
      expect(kafka?.extra_properties).toEqual({ "socket.timeout.ms": "30000" });
    });

    it("should override auth from env vars when kafkaConfig provides sasl credentials", () => {
      const config = buildConfigFromEnvAndCli(
        envWith({
          BOOTSTRAP_SERVERS: "broker:9092",
          KAFKA_API_KEY: "env-key",
          KAFKA_API_SECRET: "env-secret",
        }),
        {
          kafkaConfig: {
            "sasl.username": "k-key",
            "sasl.password": "k-secret",
          },
        },
      );
      const kafka = config.getSoleConnection().kafka;
      expect(kafka?.auth).toEqual({
        type: "api_key",
        key: "k-key",
        secret: "k-secret",
      });
      expect(kafka?.extra_properties).toBeUndefined();
    });

    it.each([
      ["bootstrap.servers", { "bootstrap.servers": "" }],
      ["sasl.username", { "sasl.username": "" }],
      ["sasl.password", { "sasl.password": "" }],
    ])(
      "should throw when kafkaConfig protected key '%s' is present but empty",
      (key, kafkaConfig) => {
        expect(() =>
          buildConfigFromEnvAndCli(envWith({ BOOTSTRAP_SERVERS: "b:9092" }), {
            kafkaConfig,
          }),
        ).toThrow(key);
      },
    );

    it.each([
      [{ "sasl.username": "k-key" }, "sasl.password"],
      [{ "sasl.password": "k-secret" }, "sasl.username"],
    ])(
      "should throw when kafkaConfig has only one SASL credential",
      (kafkaConfig, missingKey) => {
        expect(() =>
          buildConfigFromEnvAndCli(envWith({ BOOTSTRAP_SERVERS: "b:9092" }), {
            kafkaConfig,
          }),
        ).toThrow(missingKey);
      },
    );

    it("should throw when no kafka block exists and kafkaConfig has no connectivity field", () => {
      expect(() =>
        buildConfigFromEnvAndCli(
          envWith({
            CONFLUENT_CLOUD_API_KEY: "k",
            CONFLUENT_CLOUD_API_SECRET: "s",
          }),
          { kafkaConfig: { "socket.timeout.ms": "5000" } },
        ),
      ).toThrow("bootstrap.servers");
    });

    it("should throw when no kafka block exists and kafkaConfig is empty", () => {
      expect(() =>
        buildConfigFromEnvAndCli(
          envWith({
            CONFLUENT_CLOUD_API_KEY: "k",
            CONFLUENT_CLOUD_API_SECRET: "s",
          }),
          { kafkaConfig: {} },
        ),
      ).toThrow("bootstrap.servers");
    });

    it("should throw when disableAuth: true is combined with MCP_API_KEY set in env", () => {
      expect(() =>
        buildConfigFromEnvAndCli(
          envWith({
            BOOTSTRAP_SERVERS: "localhost:9092",
            MCP_API_KEY: "a".repeat(32),
          }),
          { disableAuth: true },
        ),
      ).toThrow(/MCP_AUTH_DISABLED.*MCP_API_KEY/);
    });
  });
});
