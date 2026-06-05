import { ToolDisabledReason } from "@src/confluent/tools/connection-predicates.js";
import { skipIfDisabled, skipReporter } from "@tests/harness/skip-gate.js";
import { StubHandler } from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";

describe("skip-gate.ts", () => {
  describe("skipIfDisabled()", () => {
    // The side effect under test is "the helper calls it.skip with the right
    // reason". it.skip itself is non-configurable (can't be spied), so the
    // helper routes through skipReporter.skip, which we spy on here.

    it("should return false and not skip when the handler is enabled", () => {
      const skip = vi.spyOn(skipReporter, "skip").mockImplementation(() => {});

      expect(skipIfDisabled(new StubHandler(), { type: "direct" })).toBe(false);
      expect(skip).not.toHaveBeenCalled();
    });

    it("should skip with the verdict reason and return true when disabled", () => {
      const skip = vi.spyOn(skipReporter, "skip").mockImplementation(() => {});

      expect(
        skipIfDisabled(new StubHandler({ enabled: false }), {
          type: "direct",
        }),
      ).toBe(true);
      expect(skip).toHaveBeenCalledWith(ToolDisabledReason.MissingFlinkBlock);
    });

    it("should skip with the reasonOverride when one is provided", () => {
      const skip = vi.spyOn(skipReporter, "skip").mockImplementation(() => {});

      expect(
        skipIfDisabled(
          new StubHandler({ enabled: false }),
          { type: "direct" },
          "custom precondition reason",
        ),
      ).toBe(true);
      expect(skip).toHaveBeenCalledWith("custom precondition reason");
    });
  });
});
