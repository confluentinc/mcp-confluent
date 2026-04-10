import {
  loadConfigFileContents,
  loadConfigFromYaml,
  parseYamlConfiguration,
} from "@src/config/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import sinon from "sinon";
import {
  createFsWrappers,
  type StubbedFsWrappers,
} from "@tests/stubs/node-deps.js";

describe("config/index.ts", () => {
  describe("parseYamlConfiguration", () => {
    it("should successfully parse minimal valid config (kafka only)", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
`;

      const config = parseYamlConfiguration(yamlContent);

      expect(config.connections).toBeDefined();
      expect(Object.keys(config.connections)).toHaveLength(1);
      expect(config.connections.local).toBeDefined();
      expect(config.connections.local!.type).toBe("direct");
      expect(config.connections.local!.connectionId).toBe("local");
      expect(config.connections.local!.kafka.bootstrap_servers).toBe(
        "localhost:9092",
      );
      expect(config.connections.local!.schema_registry).toBeUndefined();
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

      const config = parseYamlConfiguration(yamlContent);

      expect(config.connections.local!.schema_registry).toBeDefined();
      expect(config.connections.local!.schema_registry?.endpoint).toBe(
        "http://localhost:8081",
      );
    });

    it("should accept multiple bootstrap servers", () => {
      const yamlContent = `connections:
  cluster:
    type: "direct"
    kafka:
      bootstrap_servers: "broker1:9092,broker2:9092,broker3:9092"
`;

      const config = parseYamlConfiguration(yamlContent);

      expect(config.connections.cluster!.kafka.bootstrap_servers).toBe(
        "broker1:9092,broker2:9092,broker3:9092",
      );
    });

    it("should inject connectionId from YAML key", () => {
      const yamlContent = `connections:
  my-custom-connection-name:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
`;

      const config = parseYamlConfiguration(yamlContent);

      expect(
        config.connections["my-custom-connection-name"]!.connectionId,
      ).toBe("my-custom-connection-name");
    });

    it("should throw error on invalid YAML syntax", () => {
      const yamlContent = `connections:
  local:
    type: "direct
    kafka: [unmatched bracket
`;

      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
        /Failed to parse YAML/,
      );
    });

    it("should throw error when connections field is missing", () => {
      const yamlContent = `some_other_field: "value"
`;

      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
        /Configuration validation failed/,
      );
    });

    it("should throw error when type field is missing", () => {
      const yamlContent = `connections:
  local:
    kafka:
      bootstrap_servers: "localhost:9092"
`;

      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
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

      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
        /Configuration validation failed/,
      );
    });

    it("should throw error when kafka field is missing", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
`;

      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
        /Configuration validation failed/,
      );
    });

    it("should throw error when bootstrap_servers is missing", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      some_other_field: "value"
`;

      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
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

      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
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

      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
        /Configuration validation failed/,
      );
      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
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

      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
        /Configuration validation failed/,
      );
      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
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

      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
        /Configuration validation failed/,
      );
    });

    it("should throw error when connections map is empty", () => {
      const yamlContent = `connections: {}
`;

      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
        /Configuration validation failed/,
      );
      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
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

      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
        /Configuration validation failed/,
      );
      expect(() => parseYamlConfiguration(yamlContent)).toThrow(
        /Exactly one connection must be defined/,
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

      const config = parseYamlConfiguration(yamlContent);

      expect(config.connections.local!.schema_registry?.endpoint).toBe(
        "https://schema-registry.example.com:8081",
      );
    });
  });

  describe("loadConfigFromYaml", () => {
    const sandbox = sinon.createSandbox();
    let fsStubs: StubbedFsWrappers;

    beforeEach(() => {
      fsStubs = createFsWrappers(sandbox);
    });

    afterEach(() => {
      sandbox.restore();
    });

    it("should successfully load and parse a valid config file", () => {
      const yamlContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
`;
      fsStubs.existsSync.returns(true);
      fsStubs.readFileSync.returns(yamlContent);

      const config = loadConfigFromYaml("/path/to/config.yaml");

      expect(config.connections.local).toBeDefined();
      expect(config.connections.local!.kafka.bootstrap_servers).toBe(
        "localhost:9092",
      );
    });

    it("should throw error when file does not exist", () => {
      fsStubs.existsSync.returns(false);

      expect(() => loadConfigFromYaml("/nonexistent.yaml")).toThrow(
        /Configuration file not found/,
      );
    });

    it("should throw error on invalid YAML syntax", () => {
      fsStubs.existsSync.returns(true);
      fsStubs.readFileSync.returns("invalid: [yaml");

      expect(() => loadConfigFromYaml("/path/to/config.yaml")).toThrow(
        /Failed to parse YAML/,
      );
    });

    it("should throw error on validation failure", () => {
      const invalidYaml = `connections:
  local:
    type: "direct"
    # missing required kafka field
`;
      fsStubs.existsSync.returns(true);
      fsStubs.readFileSync.returns(invalidYaml);

      expect(() => loadConfigFromYaml("/path/to/config.yaml")).toThrow(
        /Configuration validation failed/,
      );
    });
  });

  describe("loadConfigFileContents", () => {
    const sandbox = sinon.createSandbox();
    let fsStubs: StubbedFsWrappers;

    beforeEach(() => {
      fsStubs = createFsWrappers(sandbox);
    });

    afterEach(() => {
      sandbox.restore();
    });

    it("should read file contents successfully", () => {
      const testContent = `connections:
  local:
    type: "direct"
    kafka:
      bootstrap_servers: "localhost:9092"
`;
      fsStubs.existsSync.returns(true);
      fsStubs.readFileSync.returns(testContent);

      const content = loadConfigFileContents("/some/path/config.yaml");

      expect(content).toBe(testContent);
      sinon.assert.calledOnce(fsStubs.existsSync);
      sinon.assert.calledOnce(fsStubs.readFileSync);
    });

    it("should throw error when file does not exist", () => {
      fsStubs.existsSync.returns(false);

      expect(() =>
        loadConfigFileContents("/nonexistent/path/to/config.yaml"),
      ).toThrow(/Configuration file not found/);
      sinon.assert.calledOnce(fsStubs.existsSync);
    });

    it("should throw error when file cannot be read", () => {
      fsStubs.existsSync.returns(true);
      fsStubs.readFileSync.throws(new Error("Permission denied"));

      expect(() => loadConfigFileContents("/some/path/config.yaml")).toThrow(
        /Failed to read configuration file: Permission denied/,
      );
    });
  });
});
