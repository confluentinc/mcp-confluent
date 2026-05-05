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
import {
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import {
  createFsWrappers,
  mockDotenv,
  type MockedDotenv,
  type MockedFsWrappers,
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
    let existsSyncSpy: MockInstance<typeof nodeDeps.fs.existsSync>;
    let resolveSpy: MockInstance<typeof nodeDeps.path.resolve>;
    let dotenvConfigSpy: MockedDotenv;

    beforeEach(() => {
      existsSyncSpy = vi.spyOn(nodeDeps.fs, "existsSync");
      resolveSpy = vi.spyOn(nodeDeps.path, "resolve");
      dotenvConfigSpy = mockDotenv();
    });

    it("should throw when the env file does not exist", () => {
      resolveSpy.mockReturnValue("/resolved/.env");
      existsSyncSpy.mockReturnValue(false);

      expect(() => loadDotEnvIntoProcessEnv(".env")).toThrow(
        "Environment file not found: /resolved/.env",
      );
    });

    it("should resolve the path and pass it to existsSync", () => {
      resolveSpy.mockReturnValue("/abs/path/.env");
      existsSyncSpy.mockReturnValue(false);

      expect(() => loadDotEnvIntoProcessEnv("relative/.env")).toThrow();

      expect(resolveSpy).toHaveBeenCalledWith("relative/.env");
      expect(existsSyncSpy).toHaveBeenCalledWith("/abs/path/.env");
    });

    it("should throw when dotenv.config returns an error", () => {
      resolveSpy.mockReturnValue("/resolved/.env");
      existsSyncSpy.mockReturnValue(true);
      dotenvConfigSpy.mockReturnValue({ error: new Error("parse error") });

      expect(() => loadDotEnvIntoProcessEnv(".env")).toThrow(
        "Error loading environment variables:",
      );
    });

    it("should call dotenv.config with the resolved path and override option", () => {
      resolveSpy.mockReturnValue("/abs/path/.env");
      existsSyncSpy.mockReturnValue(true);
      dotenvConfigSpy.mockReturnValue({ parsed: {} });

      loadDotEnvIntoProcessEnv("relative/.env");

      // Should call with the resolved absolute path and override: true
      // to ensure CLI env vars take precedence over existing ones in process.env
      // (and that the call will definitely mutate process.env)
      expect(dotenvConfigSpy).toHaveBeenCalledWith({
        path: "/abs/path/.env",
        override: true,
      });
    });

    it("should return the parsed variables on success", () => {
      resolveSpy.mockReturnValue("/resolved/.env");
      existsSyncSpy.mockReturnValue(true);
      dotenvConfigSpy.mockReturnValue({ parsed: { FOO: "bar", BAZ: "qux" } });

      const result = loadDotEnvIntoProcessEnv(".env");

      expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    it("should return empty object when dotenv yields no parsed variables", () => {
      resolveSpy.mockReturnValue("/resolved/.env");
      existsSyncSpy.mockReturnValue(true);
      dotenvConfigSpy.mockReturnValue({ parsed: undefined });

      const result = loadDotEnvIntoProcessEnv(".env");

      expect(result).toEqual({});
    });
  });

  describe("parseCliArgs()", () => {
    function makeArgs(trailingArgs: string[] = []): string[] {
      return ["node", "mcp-confluent", ...trailingArgs];
    }

    let fsMocks: MockedFsWrappers;
    let resolveSpy: MockInstance<typeof nodeDeps.path.resolve>;

    beforeEach(() => {
      fsMocks = createFsWrappers();
      resolveSpy = vi.spyOn(nodeDeps.path, "resolve");
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
        resolveSpy.mockReturnValue("/abs/allow.txt");
        fsMocks.existsSync.mockReturnValue(true);
        fsMocks.readFileSync.mockReturnValue(
          "tool-a\ntool-b\n# comment\n\ntool-c",
        );

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
        resolveSpy.mockReturnValue("/abs/block.txt");
        fsMocks.existsSync.mockReturnValue(true);
        fsMocks.readFileSync.mockReturnValue("tool-x\ntool-y");

        const result = parseCliArgs(
          makeArgs(["--block-tools-file", "block.txt"]),
        );

        expect(result.blockTools).toEqual(["tool-x", "tool-y"]);
      });

      it("should set listTools to true when --list-tools is specified", () => {
        const result = parseCliArgs(makeArgs(["--list-tools"]));
        expect(result.listTools).toBe(true);
      });

      it("should throw when --allow-tools-file does not exist", () => {
        resolveSpy.mockReturnValue("/abs/allow.txt");
        fsMocks.existsSync.mockReturnValue(false);

        expect(() =>
          parseCliArgs(makeArgs(["--allow-tools-file", "allow.txt"])),
        ).toThrow("Tool list file not found: /abs/allow.txt");
      });

      it("should default listTools to false", () => {
        const result = parseCliArgs(makeArgs([]));
        expect(result.listTools).toBe(false);
      });
    });

    it("should set disableAuth to true when --disable-auth is specified", () => {
      expect(parseCliArgs(makeArgs(["--disable-auth"])).disableAuth).toBe(true);
    });

    it("should leave disableAuth undefined when --disable-auth is not specified", () => {
      expect(parseCliArgs(makeArgs([])).disableAuth).toBeUndefined();
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
      resolveSpy.mockReturnValue("/abs/kafka.properties");
      fsMocks.existsSync.mockReturnValue(true);

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

    it("should throw when both --config and --transport are supplied", () => {
      expect(() =>
        parseCliArgs(
          makeArgs(["--config", "server.yaml", "--transport", "http"]),
        ),
      ).toThrow(/mutually exclusive/);
    });

    it("should throw when -k file does not exist", () => {
      resolveSpy.mockReturnValue("/abs/kafka.properties");
      fsMocks.existsSync.mockReturnValue(false);

      expect(() => parseCliArgs(makeArgs(["-k", "kafka.properties"]))).toThrow(
        "Properties file not found: /abs/kafka.properties",
      );
    });

    it("should throw when -k file cannot be parsed", () => {
      resolveSpy.mockReturnValue("/abs/kafka.properties");
      fsMocks.existsSync.mockReturnValue(true);
      fsMocks.readFileSync.mockImplementation(() => {
        throw new Error("disk error");
      });

      expect(() => parseCliArgs(makeArgs(["-k", "kafka.properties"]))).toThrow(
        "Failed to parse properties file: disk error",
      );
    });

    it.each(["-k", "--kafka-config-file"])(
      "should parse %s <path> into kafkaConfig by reading and parsing the file",
      (flag) => {
        resolveSpy.mockReturnValue("/abs/kafka.properties");
        fsMocks.existsSync.mockReturnValue(true);
        fsMocks.readFileSync.mockReturnValue(
          "bootstrap.servers=localhost:9092\nsasl.username=mykey",
        );

        const result = parseCliArgs(makeArgs([flag, "kafka.properties"]));

        expect(resolveSpy).toHaveBeenCalledWith("kafka.properties");
        expect(result.kafkaConfig).toEqual({
          "bootstrap.servers": "localhost:9092",
          "sasl.username": "mykey",
        });
      },
    );

    describe("--oauth flags", () => {
      it("should parse --oauth alone with ccloudEnv undefined", () => {
        const result = parseCliArgs(["node", "mcp-confluent", "--oauth"]);
        expect(result.oauth).toBe(true);
        expect(result.ccloudEnv).toBeUndefined();
      });

      it("should parse --oauth with --ccloud-env=devel", () => {
        const result = parseCliArgs([
          "node",
          "mcp-confluent",
          "--oauth",
          "--ccloud-env",
          "devel",
        ]);
        expect(result.oauth).toBe(true);
        expect(result.ccloudEnv).toBe("devel");
      });

      it("should accept stag and prod for --ccloud-env", () => {
        expect(
          parseCliArgs([
            "node",
            "mcp-confluent",
            "--oauth",
            "--ccloud-env",
            "stag",
          ]).ccloudEnv,
        ).toBe("stag");
        expect(
          parseCliArgs([
            "node",
            "mcp-confluent",
            "--oauth",
            "--ccloud-env",
            "prod",
          ]).ccloudEnv,
        ).toBe("prod");
      });

      it("should reject --ccloud-env without --oauth", () => {
        expect(() =>
          parseCliArgs(["node", "mcp-confluent", "--ccloud-env", "devel"]),
        ).toThrow(/--ccloud-env requires --oauth/);
      });

      it("should reject --ccloud-env with an unknown value", () => {
        expect(() =>
          parseCliArgs([
            "node",
            "mcp-confluent",
            "--oauth",
            "--ccloud-env",
            "bogus",
          ]),
        ).toThrow();
      });

      it("should reject --oauth combined with --config at parse time", () => {
        // The check fires at parse time so a malformed YAML can't mask the
        // friendlier "--oauth and --config cannot be combined" message
        // behind a generic YAML parse error.
        expect(() =>
          parseCliArgs([
            "node",
            "mcp-confluent",
            "--oauth",
            "--config",
            "/tmp/foo.yaml",
          ]),
        ).toThrow(/--oauth and --config cannot be combined/);
      });

      it("should leave oauth and ccloudEnv undefined when neither flag is set", () => {
        const result = parseCliArgs(["node", "mcp-confluent"]);
        expect(result.oauth).toBeUndefined();
        expect(result.ccloudEnv).toBeUndefined();
      });
    });
  });
});
