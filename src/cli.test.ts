import { getFilteredToolNames, loadDotEnv } from "@src/cli.js";
import * as nodeDeps from "@src/confluent/node-deps.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import sinon from "sinon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

  describe("loadDotEnv()", () => {
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

      expect(() => loadDotEnv(".env")).toThrow(
        "Environment file not found: /resolved/.env",
      );
    });

    it("should resolve the path and pass it to existsSync", () => {
      resolveStub.returns("/abs/path/.env");
      existsSyncStub.returns(false);

      expect(() => loadDotEnv("relative/.env")).toThrow();

      sinon.assert.calledWith(resolveStub, "relative/.env");
      sinon.assert.calledWith(existsSyncStub, "/abs/path/.env");
    });

    it("should throw when dotenv.config returns an error", () => {
      resolveStub.returns("/resolved/.env");
      existsSyncStub.returns(true);
      dotenvConfigStub.returns({ error: new Error("parse error") });

      expect(() => loadDotEnv(".env")).toThrow(
        "Error loading environment variables:",
      );
    });

    it("should call dotenv.config with the resolved path", () => {
      resolveStub.returns("/abs/path/.env");
      existsSyncStub.returns(true);
      dotenvConfigStub.returns({ parsed: {} });

      loadDotEnv("relative/.env");

      sinon.assert.calledWith(dotenvConfigStub, { path: "/abs/path/.env" });
    });

    it("should return the parsed variables on success", () => {
      resolveStub.returns("/resolved/.env");
      existsSyncStub.returns(true);
      dotenvConfigStub.returns({ parsed: { FOO: "bar", BAZ: "qux" } });

      const result = loadDotEnv(".env");

      expect(result).toEqual({ FOO: "bar", BAZ: "qux" });
    });

    it("should return empty object when dotenv yields no parsed variables", () => {
      resolveStub.returns("/resolved/.env");
      existsSyncStub.returns(true);
      dotenvConfigStub.returns({ parsed: undefined });

      const result = loadDotEnv(".env");

      expect(result).toEqual({});
    });
  });
});
