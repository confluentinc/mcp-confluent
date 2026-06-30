import { MINIMUM_NODE_MAJOR, nodeVersionError } from "@src/preflight.js";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

describe("MINIMUM_NODE_MAJOR", () => {
  it("should equal the major-version floor declared in package.json engines.node", () => {
    // Read the floor straight from engines.node so a bump there that forgets
    // to update the constant (or vice-versa) fails this test rather than
    // letting the two drift silently. ">=22" / ">=22.1.0" → 22.
    const enginesFloor = Number(pkg.engines.node.match(/\d+/)?.[0]);
    expect(MINIMUM_NODE_MAJOR).toBe(enginesFloor);
  });
});

describe("nodeVersionError", () => {
  it.each(["22.0.0", "22.22.1", "v22.5.0", "23.1.0", "24.3.0", "v100.0.0"])(
    "should accept supported runtime %s (returns undefined)",
    (version) => {
      expect(nodeVersionError(version, MINIMUM_NODE_MAJOR)).toBeUndefined();
    },
  );

  it.each(["18.20.4", "20.9.0", "v20.10.0", "16.0.0", "v0.10.48"])(
    "should reject unsupported runtime %s with a clear message",
    (version) => {
      const message = nodeVersionError(version, MINIMUM_NODE_MAJOR);
      expect(message).toBeDefined();
      expect(message).toContain("Node.js 22 or newer");
      expect(message).toContain(version);
    },
  );

  it.each(["", "garbage", "not.a.version"])(
    "should treat unparseable runtime %s as unsupported rather than waving it through",
    (version) => {
      expect(nodeVersionError(version, MINIMUM_NODE_MAJOR)).toContain(
        "Node.js 22 or newer",
      );
    },
  );
});
