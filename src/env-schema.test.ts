import { combinedSchema } from "@src/env-schema.js";
import { describe, expect, it } from "vitest";

describe("env-schema.ts", () => {
  describe("combinedSchema", () => {
    it("should parse successfully with no env vars set", () => {
      const result = combinedSchema.safeParse({});

      if (!result.success) {
        // try to log which field(s) caused the failure for easier debugging
        const fields = result.error.issues
          .map((i) => `  ${i.path.join(".")}: ${i.message}`)
          .join("\n");
        throw new Error(
          `A required field was added without a default or .optional(). Failing fields:\n${fields}`,
        );
      }

      expect(result.success).toBe(true);
    });
  });
});
