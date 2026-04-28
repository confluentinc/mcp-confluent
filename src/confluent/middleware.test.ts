import { describe, expect, it } from "vitest";

import { BearerTokenUnavailableError } from "@src/confluent/middleware.js";

describe("BearerTokenUnavailableError", () => {
  it("should be an Error subclass with the expected name", () => {
    const err = new BearerTokenUnavailableError("token gone");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BearerTokenUnavailableError");
    expect(err.message).toBe("token gone");
  });
});
