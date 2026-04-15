import {
  CREATE_UPDATE,
  DESTRUCTIVE,
  READ_ONLY,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { ToolHandlerRegistry } from "@src/confluent/tools/tool-registry.js";
import { describe, expect, it } from "vitest";

const ALL_TOOL_NAMES = Object.values(ToolName);

describe("tool-factory.ts", () => {
  describe("ToolFactory", () => {
    describe("createToolHandler()", () => {
      it("should have a handler for every tool", () => {
        for (const name of ALL_TOOL_NAMES) {
          expect(() => ToolHandlerRegistry.getToolHandler(name)).not.toThrow();
        }
      });

      it("should return valid ToolConfig for every registered tool", () => {
        for (const name of ALL_TOOL_NAMES) {
          const handler = ToolHandlerRegistry.getToolHandler(name);
          const config = handler.getToolConfig();

          expect(config.name).toBe(name);
          expect(config.description.length).toBeGreaterThan(10);
          expect(config.inputSchema).toBeDefined();
        }
      });

      it("should have a valid annotation (READ_ONLY, CREATE_UPDATE, or DESTRUCTIVE) for every tool", () => {
        for (const name of ALL_TOOL_NAMES) {
          const handler = ToolHandlerRegistry.getToolHandler(name);
          const config = handler.getToolConfig();

          expect(config.annotations).toBeDefined();

          const isValidAnnotation =
            config.annotations === READ_ONLY ||
            config.annotations === CREATE_UPDATE ||
            config.annotations === DESTRUCTIVE;

          expect(
            isValidAnnotation,
            `Tool ${name} must use one of: READ_ONLY, CREATE_UPDATE, or DESTRUCTIVE`,
          ).toBe(true);
        }
      });

      it("should use annotations that match the tool name prefix convention", () => {
        const readOnlyPrefixes = new Set([
          "list",
          "read",
          "get",
          "search",
          "describe",
          "check",
          "detect",
          "query",
          "consume",
        ]);
        const createUpdatePrefixes = new Set([
          "create",
          "produce",
          "add",
          "update",
          "alter",
        ]);
        const destructivePrefixes = new Set(["delete", "remove"]);

        // Prove the three sets are disjoint (no overlapping elements)
        const allPrefixes = [
          ...readOnlyPrefixes,
          ...createUpdatePrefixes,
          ...destructivePrefixes,
        ];
        const uniquePrefixCount = new Set(allPrefixes).size;
        expect(
          uniquePrefixCount,
          "Prefix sets must be disjoint (no overlapping elements)",
        ).toBe(allPrefixes.length);

        for (const name of ALL_TOOL_NAMES) {
          const handler = ToolHandlerRegistry.getToolHandler(name);
          const config = handler.getToolConfig();

          const prefix = name.split("-")[0]!;

          if (readOnlyPrefixes.has(prefix)) {
            expect(
              config.annotations,
              `Tool ${name} with prefix "${prefix}" should use READ_ONLY`,
            ).toBe(READ_ONLY);
          } else if (createUpdatePrefixes.has(prefix)) {
            expect(
              config.annotations,
              `Tool ${name} with prefix "${prefix}" should use CREATE_UPDATE`,
            ).toBe(CREATE_UPDATE);
          } else if (destructivePrefixes.has(prefix)) {
            expect(
              config.annotations,
              `Tool ${name} with prefix "${prefix}" should use DESTRUCTIVE`,
            ).toBe(DESTRUCTIVE);
          } else {
            throw new Error(
              `Tool ${name} has unrecognized prefix "${prefix}" - add it to one of the prefix sets`,
            );
          }
        }
      });
    });
  });
});
