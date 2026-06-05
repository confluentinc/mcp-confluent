import { skipIfNotEnabled } from "@tests/harness/skip-gate.js";
import { StubHandler } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("skip-gate.ts", () => {
  describe("skipIfNotEnabled()", () => {
    // Called at describe-body (collection) scope, exactly as integration gates
    // use it — so the disabled cases' it.skip() registers against this suite
    // (surfacing as skipped placeholders named after the reason / override).
    const enabledReturn = skipIfNotEnabled(new StubHandler(), {
      type: "direct",
    });
    const disabledReturn = skipIfNotEnabled(
      new StubHandler({ enabled: false }),
      { type: "direct" },
    );
    const overrideReturn = skipIfNotEnabled(
      new StubHandler({ enabled: false }),
      { type: "direct" },
      "custom precondition reason",
    );

    it("should return false (no skip) when the handler is enabled for the connection", () => {
      expect(enabledReturn).toBe(false);
    });

    it("should return true when the handler is disabled for the connection", () => {
      expect(disabledReturn).toBe(true);
    });

    it("should return true when disabled with a reason override", () => {
      expect(overrideReturn).toBe(true);
    });
  });
});
