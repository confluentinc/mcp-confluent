import {
  isExpectedToolError,
  ToolInputError,
} from "@src/confluent/tools/tool-input-error.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("tool-input-error.ts", () => {
  describe("ToolInputError", () => {
    it("should be an instance of Error carrying its own name and message", () => {
      const err = new ToolInputError("environmentId is required");

      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("ToolInputError");
      expect(err.message).toBe("environmentId is required");
    });
  });

  describe("isExpectedToolError()", () => {
    it("should return true for a ToolInputError", () => {
      expect(isExpectedToolError(new ToolInputError("x is required"))).toBe(
        true,
      );
    });

    it("should return true for a ZodError", () => {
      expect(isExpectedToolError(z.string().safeParse(42).error)).toBe(true);
    });

    it("should return false for a plain Error", () => {
      expect(isExpectedToolError(new Error("boom"))).toBe(false);
    });

    it("should return false for a non-Error value", () => {
      expect(isExpectedToolError("boom")).toBe(false);
    });
  });
});
