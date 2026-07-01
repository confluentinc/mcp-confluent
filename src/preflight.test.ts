import { MINIMUM_NODE_VERSION, nodeVersionError } from "@src/preflight.js";
import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };

describe("MINIMUM_NODE_VERSION", () => {
  it("should equal the full-version floor declared in package.json engines.node", () => {
    // Read the floor straight from engines.node so a bump there that forgets
    // to update the constant (or vice-versa) fails this test rather than
    // letting the two drift silently. ">=22.19.0" → "22.19.0".
    const enginesFloor = pkg.engines.node.match(/\d+\.\d+\.\d+/)?.[0];
    expect(MINIMUM_NODE_VERSION).toBe(enginesFloor);
  });
});

describe("nodeVersionError", () => {
  it.each(["22.19.0", "22.19.1", "22.22.1", "v22.30.0", "23.1.0", "24.3.0"])(
    "should accept supported runtime %s (returns undefined)",
    (version) => {
      expect(nodeVersionError(version, MINIMUM_NODE_VERSION)).toBeUndefined();
    },
  );

  // The regression that motivated the full-version gate (issue #455 follow-up):
  // a 22.x older than the floor passes a major-only check but then crashes
  // cryptically inside undici, so the gate must reject it on minor/patch too.
  it.each(["22.0.0", "22.10.0", "22.18.9", "v22.18.999"])(
    "should reject under-floor 22.x runtime %s despite the matching major",
    (version) => {
      const message = nodeVersionError(version, MINIMUM_NODE_VERSION);
      expect(message).toBeDefined();
      expect(message).toContain(`Node.js ${MINIMUM_NODE_VERSION} or newer`);
      expect(message).toContain(version);
    },
  );

  it.each(["18.20.4", "20.9.0", "v20.10.0", "16.0.0", "v0.10.48"])(
    "should reject unsupported runtime %s with a clear message",
    (version) => {
      const message = nodeVersionError(version, MINIMUM_NODE_VERSION);
      expect(message).toBeDefined();
      expect(message).toContain(`Node.js ${MINIMUM_NODE_VERSION} or newer`);
      expect(message).toContain(version);
    },
  );

  it.each(["", "garbage", "not.a.version"])(
    "should treat unparseable runtime %s as unsupported rather than waving it through",
    (version) => {
      expect(nodeVersionError(version, MINIMUM_NODE_VERSION)).toContain(
        `Node.js ${MINIMUM_NODE_VERSION} or newer`,
      );
    },
  );
});
