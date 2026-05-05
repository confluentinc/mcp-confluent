import {
  loadConfigFileContents,
  loadConfigFromYaml,
  parseYamlConfiguration,
} from "@src/config/index.js";
import {
  createFsWrappers,
  type MockedFsWrappers,
} from "@tests/stubs/node-deps.js";
import { beforeEach, describe, expect, it } from "vitest";

describe("config/index.ts", () => {
  describe("parseYamlConfiguration", () => {
    it("should successfully parse minimal valid config (kafka only)", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
`;

      const conn = parseYamlConfiguration(
        yamlContent,
        {},
      ).getSoleDirectConnection();

      expect(conn.type).toBe("direct");
      expect(conn.kafka!.bootstrap_servers).toBe("localhost:9092");
      expect(conn.schema_registry).toBeUndefined();
    });

    it("should successfully parse full valid config (kafka + schema_registry)", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
    schema_registry:
      endpoint: "http://localhost:8081"
`;

      const conn = parseYamlConfiguration(
        yamlContent,
        {},
      ).getSoleDirectConnection();

      expect(conn.schema_registry).toBeDefined();
      expect(conn.schema_registry?.endpoint).toBe("http://localhost:8081");
    });

    it("should accept multiple bootstrap servers", () => {
      const yamlContent = `connections:
  cluster:
    type: "direct"
    kafka:
      bootstrap_servers: "broker1:9092,broker2:9092,broker3:9092"
`;

      const conn = parseYamlConfiguration(
        yamlContent,
        {},
      ).getSoleDirectConnection();

      expect(conn.kafka!.bootstrap_servers).toBe(
        "broker1:9092,broker2:9092,broker3:9092",
      );
    });

    it("should throw error on invalid YAML syntax", () => {
      const yamlContent = `connections:
  local:
    type: "direct
    kafka: [unmatched bracket
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Failed to parse YAML/,
      );
    });

    it("should throw error when root is not an object", () => {
      const yamlContent = `"just a string"`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Configuration validation failed/,
      );
      // Should not have empty path prefix like "- :"
      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /- Invalid input: expected object, received string/,
      );
    });

    it("should throw error when connections field is missing", () => {
      const yamlContent = `some_other_field: "value"
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Configuration validation failed/,
      );
    });

    it("should throw error when type field is missing", () => {
      const yamlContent = `connections:
  local:
    kafka:
      bootstrap_servers: "localhost:9092"
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Configuration validation failed/,
      );
    });

    it("should throw error when type is not 'direct'", () => {
      const yamlContent = `connections:
  local:
    type: "unknown"
    kafka:
      bootstrap_servers: "localhost:9092"
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Configuration validation failed/,
      );
    });

    it("should throw error when neither kafka nor schema_registry is defined", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Configuration validation failed/,
      );
      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /At least one of 'kafka', 'schema_registry', 'confluent_cloud', 'tableflow', 'flink', or 'telemetry' must be defined/,
      );
    });

    it("should throw error when bootstrap_servers is missing", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      some_other_field: "value"
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Configuration validation failed/,
      );
    });

    it("should throw error when bootstrap_servers is empty", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: ""
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Configuration validation failed/,
      );
    });

    it("should throw error when bootstrap_servers has invalid format", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "invalid-no-port"
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Configuration validation failed/,
      );
      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Invalid format 'invalid-no-port': must be host:port/,
      );
    });

    it("should throw error when schema_registry endpoint is not a valid URL", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
    schema_registry:
      endpoint: "not-a-url"
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Configuration validation failed/,
      );
      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /must be a valid URL/,
      );
    });

    it("should throw error when schema_registry is present but endpoint is missing", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
    schema_registry:
      some_other_field: "value"
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Configuration validation failed/,
      );
    });

    it("should throw error when connections map is empty", () => {
      const yamlContent = `connections: {}
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Configuration validation failed/,
      );
      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Exactly one connection must be defined/,
      );
    });

    it("should throw error when connections map has more than one entry", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
  staging:
    type: "direct"
    kafka:
      bootstrap_servers: "staging:9092"
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Configuration validation failed/,
      );
      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Exactly one connection must be defined/,
      );
    });

    it("should throw error when connection name is whitespace-only", () => {
      const yamlContent = `connections:
  " ":
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Configuration validation failed/,
      );
      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Invalid key in record/,
      );
    });

    it("should accept https schema_registry endpoint", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
    schema_registry:
      endpoint: "https://schema-registry.example.com:8081"
`;

      const config = parseYamlConfiguration(yamlContent, {});

      expect(config.getSoleDirectConnection().schema_registry?.endpoint).toBe(
        "https://schema-registry.example.com:8081",
      );
    });

    it("should successfully parse config with schema_registry only (no kafka)", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    schema_registry:
      endpoint: "http://localhost:8081"
`;

      const config = parseYamlConfiguration(yamlContent, {});

      const conn = config.getSoleDirectConnection();
      expect(conn.schema_registry?.endpoint).toBe("http://localhost:8081");
      expect(conn.kafka).toBeUndefined();
    });

    it("should parse a minimal oauth connection and apply the prod default", () => {
      const yamlContent = `connections:
  prod-oauth:
    type: "oauth"
`;

      const config = parseYamlConfiguration(yamlContent, {});

      expect(config.getSoleConnection()).toEqual({
        type: "oauth",
        ccloud_env: "prod",
      });
    });

    it("should parse an explicit oauth ccloud_env value", () => {
      const yamlContent = `connections:
  stag-oauth:
    type: "oauth"
    ccloud_env: "stag"
`;

      const config = parseYamlConfiguration(yamlContent, {});

      expect(config.getSoleConnection()).toEqual({
        type: "oauth",
        ccloud_env: "stag",
      });
    });

    it("should reject an oauth connection with an unknown ccloud_env", () => {
      const yamlContent = `connections:
  bad-oauth:
    type: "oauth"
    ccloud_env: "bogus"
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /ccloud_env/,
      );
    });

    it("should interpolate ${VAR} references using provided env before Zod validation", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "\${BOOTSTRAP}"
    schema_registry:
      endpoint: "\${SR_URL}"
`;

      const config = parseYamlConfiguration(yamlContent, {
        BOOTSTRAP: "broker1:9092",
        SR_URL: "http://localhost:8081",
      });

      const conn = config.getSoleDirectConnection();
      expect(conn.kafka!.bootstrap_servers).toBe("broker1:9092");
      expect(conn.schema_registry!.endpoint).toBe("http://localhost:8081");
    });

    it("should raise a Zod validation error when an interpolated env var fails schema validation", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "\${BOOTSTRAP}"
`;

      expect(() =>
        parseYamlConfiguration(yamlContent, {
          BOOTSTRAP: "not-a-valid-host-port",
        }),
      ).toThrow(/Configuration validation failed/);
      expect(() =>
        parseYamlConfiguration(yamlContent, {
          BOOTSTRAP: "not-a-valid-host-port",
        }),
      ).toThrow(/Invalid format 'not-a-valid-host-port': must be host:port/);
    });

    describe("unknown key rejection", () => {
      it("should reject an unknown key at the connection level", () => {
        const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
    typo_field: "oops"
`;
        expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
          /Configuration validation failed/,
        );
      });

      it("should reject an unknown key inside the kafka sub-object", () => {
        const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
      boostrap_servers: "typo"
`;
        expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
          /Configuration validation failed/,
        );
      });

      it("should reject an unknown key inside the schema_registry sub-object", () => {
        const yamlContent = `connections:
  local:
    type: "direct"
    schema_registry:
      endpoint: "http://localhost:8081"
      endpint: "typo"
`;
        expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
          /Configuration validation failed/,
        );
      });

      it("should reject an unknown key inside the auth block", () => {
        const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
      auth:
        type: api_key
        key: "mykey"
        secret: "mysecret"
        extra_field: "oops"
`;
        expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
          /Configuration validation failed/,
        );
      });
    });

    it("should throw when a referenced variable is missing from env", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "\${MISSING_VAR}"
`;

      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /Failed to interpolate configuration values/,
      );
      expect(() => parseYamlConfiguration(yamlContent, {})).toThrow(
        /MISSING_VAR/,
      );
    });
  });

  describe("loadConfigFromYaml", () => {
    let fsMocks: MockedFsWrappers;

    beforeEach(() => {
      fsMocks = createFsWrappers();
    });

    it("should successfully load and parse a valid config file", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
`;
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(yamlContent);

      const config = loadConfigFromYaml("/path/to/config.yaml", {});

      expect(config.getSoleDirectConnection().kafka!.bootstrap_servers).toBe(
        "localhost:9092",
      );
    });

    it("should pass env argument to parseYamlConfiguration for variable interpolation", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "\${BOOTSTRAP_SERVERS}"
`;
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(yamlContent);

      const config = loadConfigFromYaml("/path/to/config.yaml", {
        BOOTSTRAP_SERVERS: "broker1:9092",
      });

      expect(config.getSoleDirectConnection().kafka!.bootstrap_servers).toBe(
        "broker1:9092",
      );
    });

    it("should throw error when file does not exist", () => {
      fsMocks.existsSync.mockReturnValue(false);

      expect(() => loadConfigFromYaml("/nonexistent.yaml", {})).toThrow(
        /Configuration file not found/,
      );
    });

    it("should throw error on invalid YAML syntax", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue("invalid: [yaml");

      expect(() => loadConfigFromYaml("/path/to/config.yaml", {})).toThrow(
        /Failed to parse YAML/,
      );
    });

    it("should throw error on validation failure", () => {
      const invalidYaml = `connections:
  local:
    type: "direct"
    # missing both kafka and schema_registry
`;
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(invalidYaml);

      expect(() => loadConfigFromYaml("/path/to/config.yaml", {})).toThrow(
        /Configuration validation failed/,
      );
    });
  });

  describe("loadConfigFileContents", () => {
    let fsMocks: MockedFsWrappers;

    beforeEach(() => {
      fsMocks = createFsWrappers();
    });

    it("should read file contents successfully", () => {
      const testContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
`;
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockReturnValue(testContent);

      const content = loadConfigFileContents("/some/path/config.yaml");

      expect(content).toBe(testContent);
      expect(fsMocks.existsSync).toHaveBeenCalledOnce();
      expect(fsMocks.readFileSync).toHaveBeenCalledOnce();
    });

    it("should throw error when file does not exist", () => {
      fsMocks.existsSync.mockReturnValue(false);

      expect(() =>
        loadConfigFileContents("/nonexistent/path/to/config.yaml"),
      ).toThrow(/Configuration file not found/);
      expect(fsMocks.existsSync).toHaveBeenCalledOnce();
    });

    it("should throw error when file cannot be read", () => {
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockImplementation(() => {
        throw new Error("Permission denied");
      });

      expect(() => loadConfigFileContents("/some/path/config.yaml")).toThrow(
        /Failed to read configuration file: Permission denied/,
      );
    });
  });
});
