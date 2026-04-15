import { getFilteredToolNames } from "@src/cli.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { describe, expect, it } from "vitest";

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
});
