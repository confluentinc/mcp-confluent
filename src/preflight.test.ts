import { MINIMUM_NODE_MAJOR, nodeVersionError } from "@src/preflight.js";
import { describe, expect, it } from "vitest";

describe("MINIMUM_NODE_MAJOR", () => {
  it("should match the engines.node floor declared in package.json", () => {
    expect(MINIMUM_NODE_MAJOR).toBe(22);
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
