import {
  describeTelemetryError,
  formatHttpStatusPart,
} from "@src/confluent/tools/handlers/metrics/telemetry-error.js";
import { describe, expect, it } from "vitest";

describe("telemetry-error.ts", () => {
  describe("formatHttpStatusPart()", () => {
    it("should return an empty string when status is undefined", () => {
      expect(formatHttpStatusPart(undefined)).toBe("");
    });

    it("should format a defined status as ' (HTTP <status>)'", () => {
      expect(formatHttpStatusPart(403)).toBe(" (HTTP 403)");
    });
  });

  describe("describeTelemetryError()", () => {
    it("should join errors[].detail entries with '; '", () => {
      expect(
        describeTelemetryError({
          errors: [{ detail: "bad metric" }, { detail: "wrong dataset" }],
        }),
      ).toBe("bad metric; wrong dataset");
    });

    it("should preserve an Error payload's message rather than JSON-stringifying it to {}", () => {
      expect(describeTelemetryError(new Error("token expired"))).toBe(
        "token expired",
      );
    });

    it("should not throw when the error payload is a circular structure", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(() => describeTelemetryError(circular)).not.toThrow();
    });

    it("should not throw when errors is present but not an array, falling back to stringifying the payload", () => {
      const payload = { errors: "not an array" };
      expect(() => describeTelemetryError(payload)).not.toThrow();
      expect(describeTelemetryError(payload)).toBe(JSON.stringify(payload));
    });

    it("should stringify a plain non-Error value", () => {
      expect(describeTelemetryError("boom")).toBe('"boom"');
    });
  });
});
