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

  describe("confluent_cloud and tableflow fixtures", () => {
    it("should load ccloud-with-auth with auth and no endpoint", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/ccloud-with-auth.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.confluent_cloud?.auth).toEqual({
        type: "api_key",
        key: "mycloudkey",
        secret: "mycloudsecret",
      });
      expect(conn.confluent_cloud?.endpoint).toBe(
        "https://api.confluent.cloud",
      );
      expect(conn.kafka).toBeUndefined();
      expect(conn.schema_registry).toBeUndefined();
      expect(conn.tableflow).toBeUndefined();
    });

    it("should load ccloud-with-endpoint-and-auth with both fields populated", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/ccloud-with-endpoint-and-auth.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.confluent_cloud?.endpoint).toBe(
        "https://custom.confluent.cloud",
      );
      expect(conn.confluent_cloud?.auth).toEqual({
        type: "api_key",
        key: "mycloudkey",
        secret: "mycloudsecret",
      });
    });

    it("should load tableflow-with-auth with auth block", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/tableflow-with-auth.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.tableflow?.auth).toEqual({
        type: "api_key",
        key: "mytableflowkey",
        secret: "mytableflowsecret",
      });
      expect(conn.kafka).toBeUndefined();
      expect(conn.schema_registry).toBeUndefined();
      expect(conn.confluent_cloud).toBeUndefined();
    });

    it("should load ccloud-and-tableflow-with-auth with both blocks populated", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/ccloud-and-tableflow-with-auth.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.confluent_cloud?.endpoint).toBe(
        "https://api.confluent.cloud",
      );
      expect(conn.confluent_cloud?.auth).toEqual({
        type: "api_key",
        key: "mycloudkey",
        secret: "mycloudsecret",
      });
      expect(conn.tableflow?.auth).toEqual({
        type: "api_key",
        key: "mytableflowkey",
        secret: "mytableflowsecret",
      });
    });
  });

  describe("kafka extra_properties fixtures", () => {
    it("should load kafka-with-extra-properties and parse the extra_properties block", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/kafka-with-extra-properties.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.kafka?.bootstrap_servers).toBe("broker.confluent.cloud:9092");
      expect(conn.kafka?.extra_properties).toEqual({
        "socket.timeout.ms": "30000",
        "ssl.ca.location": "/etc/ssl/certs/ca-certificates.crt",
        debug: "broker,topic",
      });
    });
  });

  describe("kafka REST metadata fixtures", () => {
    it("should load kafka-with-rest-metadata with all three metadata fields", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/kafka-with-rest-metadata.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.kafka?.bootstrap_servers).toBe("broker.confluent.cloud:9092");
      expect(conn.kafka?.rest_endpoint).toBe(
        "https://pkc-abc123.us-east-1.aws.confluent.cloud:443",
      );
      expect(conn.kafka?.cluster_id).toBe("lkc-abc123");
      expect(conn.kafka?.env_id).toBe("env-xyz789");
    });
  });

  describe("flink fixtures", () => {
    it("should load flink-with-required-fields with auth and required context fields", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/flink-with-required-fields.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.flink?.auth).toEqual({
        type: "api_key",
        key: "myflinkkey",
        secret: "myflinksecret",
      });
      expect(conn.flink?.endpoint).toBe(
        "https://flink.us-east-1.aws.confluent.cloud",
      );
      expect(conn.flink?.environment_id).toBe("env-abc123");
      expect(conn.flink?.organization_id).toBe("org-xyz789");
      expect(conn.flink?.compute_pool_id).toBe("lfcp-pool01");
      expect(conn.flink?.environment_name).toBeUndefined();
      expect(conn.flink?.database_name).toBeUndefined();
      expect(conn.kafka).toBeUndefined();
      expect(conn.schema_registry).toBeUndefined();
      expect(conn.confluent_cloud).toBeUndefined();
      expect(conn.tableflow).toBeUndefined();
    });

    it("should load flink-with-all-fields with every field populated", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/flink-with-all-fields.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.flink?.endpoint).toBe("https://flink.confluent.cloud");
      expect(conn.flink?.auth).toEqual({
        type: "api_key",
        key: "myflinkkey",
        secret: "myflinksecret",
      });
      expect(conn.flink?.environment_id).toBe("env-abc123");
      expect(conn.flink?.organization_id).toBe("org-xyz789");
      expect(conn.flink?.compute_pool_id).toBe("lfcp-pool01");
      expect(conn.flink?.environment_name).toBe("my-environment");
      expect(conn.flink?.database_name).toBe("my-kafka-cluster");
    });

    it("should load ccloud-and-flink-with-auth with both blocks populated", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/ccloud-and-flink-with-auth.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.confluent_cloud?.auth).toEqual({
        type: "api_key",
        key: "mycloudkey",
        secret: "mycloudsecret",
      });
      expect(conn.flink?.auth).toEqual({
        type: "api_key",
        key: "myflinkkey",
        secret: "myflinksecret",
      });
      expect(conn.flink?.environment_id).toBe("env-abc123");
    });
  });

  describe("telemetry fixtures", () => {
    it("should load telemetry-with-auth with auth only and resolve default endpoint", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/telemetry-with-auth.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.telemetry).toEqual({
        endpoint: "https://api.telemetry.confluent.cloud",
        auth: {
          type: "api_key",
          key: "mytelemetrykey",
          secret: "mytelemetrysecret",
        },
      });
      expect(conn.kafka).toBeUndefined();
      expect(conn.flink).toBeUndefined();
    });

    it("should load telemetry-with-endpoint-and-auth with both fields populated", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/telemetry-with-endpoint-and-auth.yaml"),
        NO_ENV,
      );
      const conn = config.getSoleConnection();
      expect(conn.telemetry?.endpoint).toBe(
        "https://api.telemetry.confluent.cloud",
      );
      expect(conn.telemetry?.auth).toEqual({
        type: "api_key",
        key: "mytelemetrykey",
        secret: "mytelemetrysecret",
      });
    });
  });

  describe("server block fixtures", () => {
    it("should load a config with a server block and populate server fields", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/kafka-with-server-block.yaml"),
        NO_ENV,
      );
      expect(config.server.log_level).toBe("debug");
      expect(config.server.http.port).toBe(9090);
      expect(config.server.http.host).toBe("0.0.0.0");
      expect(config.server.http.mcp_endpoint).toBe("/mcp");
      expect(config.server.auth.allowed_hosts).toEqual([
        "localhost",
        "example.com",
      ]);
      expect(config.server.auth.api_key).toBeUndefined();
    });

    it("should reject server.auth with disabled:true and api_key both set", () => {
      expect(() =>
        loadConfigFromYaml(
          fixtureFile("invalid/server-auth-disabled-with-api-key.yaml"),
          NO_ENV,
        ),
      ).toThrow(/Configuration validation failed/);
    });

    it("should load server.transports and server.do_not_track from YAML", () => {
      const config = loadConfigFromYaml(
        fixtureFile("valid/kafka-with-server-transports.yaml"),
        NO_ENV,
      );
      expect(config.server.transports).toEqual(["http", "sse"]);
      expect(config.server.do_not_track).toBe(true);
    });

    it("should reject an empty server.transports array", () => {
      expect(() =>
        loadConfigFromYaml(
          fixtureFile("invalid/server-transports-empty.yaml"),
          NO_ENV,
        ),
      ).toThrow(/Configuration validation failed/);
    });

    it("should return the YAML do_not_track value even when DO_NOT_TRACK is set in the environment", () => {
      // loadConfigFromYaml does not apply the env-var floor — that is the
      // caller's responsibility (index.ts ORs mcpConfig.server.do_not_track
      // with env.DO_NOT_TRACK before calling TelemetryService.initialize).
      const config = loadConfigFromYaml(
        fixtureFile("valid/kafka-with-server-block.yaml"),
        { DO_NOT_TRACK: "true" },
      );
      expect(config.server.do_not_track).toBe(false);
    });
  });

  describe("config.example.yaml", () => {
    // Prove that the example config can be parsed successfully with a minimal environment providing values for the fields
    // that it references using ${VAR} interpolation. This ensures the example is a valid config that can be used as a starting
    // point by users as the codebase evolves.

    // Minimal env: supply values for every ${VAR} placeholder that has no :-default.
    // Placeholders with defaults (e.g. ${KAFKA_BOOTSTRAP_SERVERS:-pkc-xxxxx...}) resolve
    // on their own; only the bare auth fields need values to pass schema validation.
    const EXAMPLE_ENV: Record<string, string> = {
      KAFKA_API_KEY: "example-kafka-key",
      KAFKA_API_SECRET: "example-kafka-secret",
      SCHEMA_REGISTRY_API_KEY: "example-sr-key",
      SCHEMA_REGISTRY_API_SECRET: "example-sr-secret",
      CONFLUENT_CLOUD_API_KEY: "example-cloud-key",
      CONFLUENT_CLOUD_API_SECRET: "example-cloud-secret",
      FLINK_API_KEY: "example-flink-key",
      FLINK_API_SECRET: "example-flink-secret",
      FLINK_ORG_ID: "example-org-id",
      TABLEFLOW_API_KEY: "example-tableflow-key",
      TABLEFLOW_API_SECRET: "example-tableflow-secret",
    };

    const EXAMPLE_FILE = fileURLToPath(
      new URL("../../config.example.yaml", import.meta.url),
    );

    it("should parse without error", () => {
      expect(() => loadConfigFromYaml(EXAMPLE_FILE, EXAMPLE_ENV)).not.toThrow();
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

    it("should reject a tableflow block with no auth", () => {
      expect(() =>
        loadConfigFromYaml(fixtureFile("invalid/tableflow-empty.yaml"), NO_ENV),
      ).toThrow(/tableflow\.auth/);
    });

    it("should reject a confluent_cloud block with no auth", () => {
      expect(() =>
        loadConfigFromYaml(fixtureFile("invalid/ccloud-empty.yaml"), NO_ENV),
      ).toThrow(/confluent_cloud\.auth/);
    });

    it("should include a descriptive field path in error messages for empty key", () => {
      expect(() =>
        loadConfigFromYaml(fixtureFile("invalid/auth-empty-key.yaml"), NO_ENV),
      ).toThrow(/auth\.key cannot be empty/);
    });

    it("should reject a flink block with no fields", () => {
      expect(() =>
        loadConfigFromYaml(fixtureFile("invalid/flink-empty.yaml"), NO_ENV),
      ).toThrow(/flink\.auth/);
    });

    it("should reject a telemetry block with neither endpoint nor auth", () => {
      expect(() =>
        loadConfigFromYaml(fixtureFile("invalid/telemetry-empty.yaml"), NO_ENV),
      ).toThrow(/telemetry block must contain at least 'endpoint' or 'auth'/);
    });

    it("should reject a kafka block with env_id lacking the env- prefix", () => {
      expect(() =>
        loadConfigFromYaml(
          fixtureFile("invalid/kafka-invalid-env-id.yaml"),
          NO_ENV,
        ),
      ).toThrow(/kafka\.env_id must start with 'env-'/);
    });

    it("should reject kafka extra_properties containing a protected key", () => {
      expect(() =>
        loadConfigFromYaml(
          fixtureFile("invalid/kafka-extra-properties-protected-key.yaml"),
          NO_ENV,
        ),
      ).toThrow(/bootstrap\.servers/);
    });

    it("should reject kafka extra_properties containing protected auth keys", () => {
      expect(() =>
        loadConfigFromYaml(
          fixtureFile(
            "invalid/kafka-extra-properties-protected-auth-keys.yaml",
          ),
          NO_ENV,
        ),
      ).toThrow(/sasl\.(username|password)/);
    });

    it("should reject a flink block that has endpoint but is missing other required fields", () => {
      expect(() =>
        loadConfigFromYaml(
          fixtureFile("invalid/flink-missing-required-fields.yaml"),
          NO_ENV,
        ),
      ).toThrow(/flink\.auth/);
      expect(() =>
        loadConfigFromYaml(
          fixtureFile("invalid/flink-missing-required-fields.yaml"),
          NO_ENV,
        ),
      ).not.toThrow(/flink\.endpoint/);
    });

    it("should reject telemetry-with-endpoint-only when no confluent_cloud.auth is available", () => {
      expect(() =>
        loadConfigFromYaml(
          fixtureFile("invalid/telemetry-with-endpoint-only.yaml"),
          NO_ENV,
        ),
      ).toThrow(/no auth is available/);
    });
  });
});
