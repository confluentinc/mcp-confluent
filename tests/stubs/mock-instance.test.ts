import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it, type Mocked, vi } from "vitest";

class Base {
  inherited(): string {
    return "real-inherited";
  }
  shared(): string {
    return "base-shared";
  }
}

class Derived extends Base {
  own(): string {
    return "real-own";
  }
  override shared(): string {
    return "derived-shared";
  }
}

describe("mock-instance.ts", () => {
  describe("createMockInstance", () => {
    it("should stub methods declared on the constructor's own prototype", () => {
      const stub = createMockInstance(Derived);
      expect(vi.isMockFunction(stub.own)).toBe(true);
      stub.own.mockReturnValue("mocked-own");
      expect(stub.own()).toBe("mocked-own");
    });

    it("should stub methods inherited from a base class", () => {
      const stub: Mocked<Derived> = createMockInstance(Derived);
      expect(vi.isMockFunction(stub.inherited)).toBe(true);
      stub.inherited.mockReturnValue("mocked-inherited");
      expect(stub.inherited()).toBe("mocked-inherited");
    });

    it("should let subclass overrides shadow the base method's stub", () => {
      const stub = createMockInstance(Derived);
      stub.shared.mockReturnValue("mocked-shared");
      expect(stub.shared()).toBe("mocked-shared");
      // The instance's own `shared` is the stub (subclass override path), not the base's.
      expect(stub.shared).toBe(
        Object.getOwnPropertyDescriptor(stub, "shared")?.value,
      );
    });

    it("should not stub the constructor itself", () => {
      const stub = createMockInstance(Derived);
      expect(stub).toBeInstanceOf(Derived);
    });
  });
});
