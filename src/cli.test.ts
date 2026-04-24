import { CommanderError } from "@commander-js/extra-typings";
import {
  DisplayedCommandLineUsageError,
  getFilteredToolNames,
  loadDotEnvIntoProcessEnv,
  parseCliArgs,
} from "@src/cli.js";
import * as nodeDeps from "@src/confluent/node-deps.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { TransportType } from "@src/mcp/transports/types.js";
import sinon from "sinon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFsWrappers,
  StubbedFsWrappers,
} from "../tests/stubs/node-deps.js";

describe("cli.ts", () => {
  const ALL_TOOL_NAMES = Object.values(ToolName).sort();

  describe("getFilteredToolNames()", () => {
    it("should return all tools sorted when both lists are empty", () => {
      const result = getFilteredToolNames([], []);
      expect(result).toEqual(ALL_TOOL_NAMES);
    });

    it("should return only the specified tools when allow list contains valid names", () => {
      const result = getFilteredToolNames(
        [ToolName.LIST_TOPICS, ToolName.CREATE_TOPICS],
        [],
      );
      expect(result).toEqual(
        [ToolName.LIST_TOPICS, ToolName.CREATE_TOPICS].sort(),
      );
    });

    it("should return empty array when allow list contains only invalid names", () => {
      const result = getFilteredToolNames(["not-a-real-tool", "also-fake"], []);
      expect(result).toEqual([]);
    });

    it("should include only valid names when allow list mixes valid and invalid", () => {
      const result = getFilteredToolNames(
        [ToolName.LIST_TOPICS, "not-a-real-tool"],
        [],
      );
      expect(result).toEqual([ToolName.LIST_TOPICS]);
    });

    it("should return all tools except the blocked one when block list contains a valid name", () => {
      const result = getFilteredToolNames([], [ToolName.LIST_TOPICS]);
      expect(result).not.toContain(ToolName.LIST_TOPICS);
      expect(result.length).toBe(ALL_TOOL_NAMES.length - 1);
      expect(result).toEqual(
        ALL_TOOL_NAMES.filter((t) => t !== ToolName.LIST_TOPICS),
      );
    });

    it("should block only valid names when block list mixes valid and invalid", () => {
      const result = getFilteredToolNames(
        [],
        [ToolName.LIST_TOPICS, "not-a-real-tool"],
      );
      expect(result).not.toContain(ToolName.LIST_TOPICS);
      expect(result.length).toBe(ALL_TOOL_NAMES.length - 1);
    });

    it("should return all tools unchanged when block list contains only invalid names", () => {
      const result = getFilteredToolNames([], ["not-a-real-tool"]);
      expect(result).toEqual(ALL_TOOL_NAMES);
    });

    it("should apply allow list first then subtract block list", () => {
      const result = getFilteredToolNames(
        [ToolName.LIST_TOPICS, ToolName.CREATE_TOPICS],
        [ToolName.CREATE_TOPICS],
      );
      expect(result).toEqual([ToolName.LIST_TOPICS]);
    });

    it("should return empty array when all allowed tools are also blocked", () => {
      const result = getFilteredToolNames(
        [ToolName.LIST_TOPICS],
        [ToolName.LIST_TOPICS],
      );
      expect(result).toEqual([]);
    });

    it("should always return results in alphabetical order", () => {
      const result = getFilteredToolNames(
        [
          ToolName.PRODUCE_MESSAGE,
          ToolName.LIST_TOPICS,
          ToolName.CREATE_TOPICS,
        ],
        [],
      );
      const sorted = [...result].sort();
      expect(result).toEqual(sorted);
    });
  });

  describe("loadDotEnvIntoProcessEnv()", () => {
    let sandbox: sinon.SinonSandbox;
    let existsSyncStub: sinon.SinonStub;
    let resolveStub: sinon.SinonStub;
    let dotenvConfigStub: sinon.SinonStub;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      existsSyncStub = sandbox.stub(nodeDeps.fs, "existsSync");
      resolveStub = sandbox.stub(nodeDeps.path, "resolve");
      dotenvConfigStub = sandbox.stub(nodeDeps.dotenvLib, "config");
    });

    afterEach(() => {
      sandbox.restore();
    });

    it("should throw when the env file does not exist", () => {
      resolveStub.returns("/resolved/.env");
      existsSyncStub.returns(false);

      expect(() => loadDotEnvIntoProcessEnv(".env")).toThrow(
        "Environment file not found: /resolved/.env",
      );
    });

    it("should resolve the path and pass it to existsSync", () => {
      resolveStub.returns("/abs/path/.env");
      existsSyncStub.returns(false);

      expect(() => loadDotEnvIntoProcessEnv("relative/.env")).toThrow();

      sinon.assert.calledWith(resolveStub, "relative/.env");
      sinon.assert.calledWith(existsSyncStub, "/abs/path/.env");
    });

    it("should throw when dotenv.config returns an error", () => {
      resolveStub.returns("/resolved/.env");
      existsSyncStub.returns(true);
      dotenvConfigStub.returns({ error: new Error("parse error") });

      expect(() => loadDotEnvIntoProcessEnv(".env")).toThrow(
        "Error loading environment variables:",
      );
    });

    it("should call dotenv.config with the resolved path and override option", () => {
      resolveStub.returns("/abs/path/.env");
      existsSyncStub.returns(true);
      dotenvConfigStub.returns({ parsed: {} });

      loadDotEnvIntoProcessEnv("relative/.env");

      // Should call with the resolved absolute path and override: true
      // to ensure CLI env vars take precedence over existing ones in process.env
      // (and that the call will definitely mutate process.env)
      sinon.assert.calledWith(dotenvConfigStub, {
        path: "/abs/path/.env",
        override: true,
      });
    });

    it("should return the parsed variables on success", () => {
      resolveStub.returns("/resolved/.env");
      existsSyncStub.returns(true);
      dotenvConfigStub.returns({ parsed: { FOO: "bar", BAZ: "qux" } });

      const result = loadDotEnvIntoProcessEnv(".env");

      expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    it("should return empty object when dotenv yields no parsed variables", () => {
      resolveStub.returns("/resolved/.env");
      existsSyncStub.returns(true);
      dotenvConfigStub.returns({ parsed: undefined });

      const result = loadDotEnvIntoProcessEnv(".env");

      expect(result).toEqual({});
    });
  });

  describe("parseCliArgs()", () => {
    function makeArgs(trailingArgs: string[] = []): string[] {
      return ["node", "mcp-confluent", ...trailingArgs];
    }

    let sandbox: sinon.SinonSandbox;
    let fsStubs: StubbedFsWrappers;
    let resolveStub: sinon.SinonStub;

    beforeEach(() => {
      sandbox = sinon.createSandbox();
      fsStubs = createFsWrappers(sandbox);
      resolveStub = sandbox.stub(nodeDeps.path, "resolve");
    });

    afterEach(() => {
      sandbox.restore();
    });

    describe("error handling", () => {
      it("should throw DisplayedCommandLineUsageError when passed --help", () => {
        expect(() => parseCliArgs(makeArgs(["--help"]))).toThrow(
          DisplayedCommandLineUsageError,
        );
      });

      it("should throw a raw CommanderError when passed an unknown argument", () => {
        expect(() => parseCliArgs(makeArgs(["--not-a-real-flag"]))).toThrow(
          CommanderError,
        );
      });
    });

    it.each(["-e", "--env-file"])(
      "should parse %s <path> into envFile",
      (flag) => {
        const result = parseCliArgs(makeArgs([flag, "my.env"]));
        expect(result.envFile).toBe("my.env");
      },
    );

    it.each(["-c", "--config"])(
      "should parse %s <path> into config",
      (flag) => {
        const result = parseCliArgs(makeArgs([flag, "my.yaml"]));
        expect(result.config).toBe("my.yaml");
      },
    );

    describe("-t / --transport", () => {
      it("should default to [stdio] when not specified", () => {
        const result = parseCliArgs(makeArgs([]));
        expect(result.transports).toEqual([TransportType.STDIO]);
      });

      it.each([
        ["-t", "http", [TransportType.HTTP]],
        ["-t", "sse", [TransportType.SSE]],
        ["-t", "http,sse", [TransportType.HTTP, TransportType.SSE]],
        [
          "-t",
          "http,sse,stdio",
          [TransportType.HTTP, TransportType.SSE, TransportType.STDIO],
        ],
        ["--transport", "stdio", [TransportType.STDIO]],
        [
          "--transport",
          "stdio,http",
          [TransportType.STDIO, TransportType.HTTP],
        ],
      ] as const)(
        "should parse %s %s into transports",
        (flag, value, expected) => {
          const result = parseCliArgs(makeArgs([flag, value]));
          expect(result.transports).toEqual(expected);
        },
      );

      it("should throw when given an invalid transport type", () => {
        expect(() => parseCliArgs(makeArgs(["-t", "bogus"]))).toThrow();
      });
    });

    describe("tool filtering flags", () => {
      it("should parse --allow-tools into allowTools array", () => {
        const result = parseCliArgs(
          makeArgs(["--allow-tools", "tool-a,tool-b"]),
        );
        expect(result.allowTools).toEqual(["tool-a", "tool-b"]);
      });

      it("should parse --allow-tools-file into allowTools by reading file lines", () => {
        resolveStub.returns("/abs/allow.txt");
        fsStubs.existsSync.returns(true);
        fsStubs.readFileSync.returns("tool-a\ntool-b\n# comment\n\ntool-c");

        const result = parseCliArgs(
          makeArgs(["--allow-tools-file", "allow.txt"]),
        );

        expect(result.allowTools).toEqual(["tool-a", "tool-b", "tool-c"]);
      });

      it("should parse --block-tools into blockTools array", () => {
        const result = parseCliArgs(
          makeArgs(["--block-tools", "tool-x,tool-y"]),
        );
        expect(result.blockTools).toEqual(["tool-x", "tool-y"]);
      });

      it("should parse --block-tools-file into blockTools by reading file lines", () => {
        resolveStub.returns("/abs/block.txt");
        fsStubs.existsSync.returns(true);
        fsStubs.readFileSync.returns("tool-x\ntool-y");

        const result = parseCliArgs(
          makeArgs(["--block-tools-file", "block.txt"]),
        );

        expect(result.blockTools).toEqual(["tool-x", "tool-y"]);
      });

      it("should set listTools to true when --list-tools is specified", () => {
        const result = parseCliArgs(makeArgs(["--list-tools"]));
        expect(result.listTools).toBe(true);
      });

      it("should set disableConfluentCloudTools to true when --disable-confluent-cloud-tools is specified", () => {
        const result = parseCliArgs(
          makeArgs(["--disable-confluent-cloud-tools"]),
        );
        expect(result.disableConfluentCloudTools).toBe(true);
      });

      it("should throw when --allow-tools-file does not exist", () => {
        resolveStub.returns("/abs/allow.txt");
        fsStubs.existsSync.returns(false);

        expect(() =>
          parseCliArgs(makeArgs(["--allow-tools-file", "allow.txt"])),
        ).toThrow("Tool list file not found: /abs/allow.txt");
      });

      it("should default listTools and disableConfluentCloudTools to false", () => {
        const result = parseCliArgs(makeArgs([]));
        expect(result.listTools).toBe(false);
        expect(result.disableConfluentCloudTools).toBe(false);
      });
    });

    it("should set disableAuth to true when --disable-auth is specified", () => {
      expect(parseCliArgs(makeArgs(["--disable-auth"])).disableAuth).toBe(true);
    });

    it("should set generateKey to true when --generate-key is specified", () => {
      expect(parseCliArgs(makeArgs(["--generate-key"])).generateKey).toBe(true);
    });

    it("should parse --allowed-hosts into a lowercased array", () => {
      const result = parseCliArgs(
        makeArgs(["--allowed-hosts", "Localhost,127.0.0.1,MyHost.local"]),
      );
      expect(result.allowedHosts).toEqual([
        "localhost",
        "127.0.0.1",
        "myhost.local",
      ]);
    });

    it("should throw when both --config and --kafka-config-file are supplied", () => {
      resolveStub.returns("/abs/kafka.properties");
      fsStubs.existsSync.returns(true);

      expect(() =>
        parseCliArgs(
          makeArgs(["--config", "server.yaml", "-k", "kafka.properties"]),
        ),
      ).toThrow(/mutually exclusive/);
    });

    it("should throw when both --config and --disable-auth are supplied", () => {
      expect(() =>
        parseCliArgs(makeArgs(["--config", "server.yaml", "--disable-auth"])),
      ).toThrow(/mutually exclusive/);
    });

    it("should throw when both --config and --allowed-hosts are supplied", () => {
      expect(() =>
        parseCliArgs(
          makeArgs(["--config", "server.yaml", "--allowed-hosts", "localhost"]),
        ),
      ).toThrow(/mutually exclusive/);
    });

    it("should throw when -k file does not exist", () => {
      resolveStub.returns("/abs/kafka.properties");
      fsStubs.existsSync.returns(false);

      expect(() => parseCliArgs(makeArgs(["-k", "kafka.properties"]))).toThrow(
        "Properties file not found: /abs/kafka.properties",
      );
    });

    it("should throw when -k file cannot be parsed", () => {
      resolveStub.returns("/abs/kafka.properties");
      fsStubs.existsSync.returns(true);
      fsStubs.readFileSync.throws(new Error("disk error"));

      expect(() => parseCliArgs(makeArgs(["-k", "kafka.properties"]))).toThrow(
        "Failed to parse properties file: disk error",
      );
    });

    it.each(["-k", "--kafka-config-file"])(
      "should parse %s <path> into kafkaConfig by reading and parsing the file",
      (flag) => {
        resolveStub.returns("/abs/kafka.properties");
        fsStubs.existsSync.returns(true);
        fsStubs.readFileSync.returns(
          "bootstrap.servers=localhost:9092\nsasl.username=mykey",
        );

        const result = parseCliArgs(makeArgs([flag, "kafka.properties"]));

        sinon.assert.calledWith(resolveStub, "kafka.properties");
        expect(result.kafkaConfig).toEqual({
          "bootstrap.servers": "localhost:9092",
          "sasl.username": "mykey",
        });
      },
    );
  });
});
