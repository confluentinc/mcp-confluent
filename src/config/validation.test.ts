import { validateBootstrapServers } from "@src/config/validation.js";
import { describe, expect, it } from "vitest";

describe("config/validation.ts", () => {
  describe("validateBootstrapServers", () => {
    it("should accept valid single server", () => {
      expect(() => validateBootstrapServers("localhost:9092")).not.toThrow();
    });

    it("should accept valid multiple servers", () => {
      expect(() =>
        validateBootstrapServers("host1:9092,host2:9093"),
      ).not.toThrow();
      expect(() =>
        validateBootstrapServers(
          "kafka1.example.com:9092,kafka2.example.com:9093,kafka3.example.com:9094",
        ),
      ).not.toThrow();
    });

    it("should accept servers with IP addresses", () => {
      expect(() => validateBootstrapServers("127.0.0.1:9092")).not.toThrow();
      expect(() =>
        validateBootstrapServers("192.168.1.100:9092,192.168.1.101:9093"),
      ).not.toThrow();
    });

    it("should accept servers with whitespace around commas", () => {
      expect(() =>
        validateBootstrapServers("host1:9092, host2:9093"),
      ).not.toThrow();
      expect(() =>
        validateBootstrapServers("host1:9092 , host2:9093 , host3:9094"),
      ).not.toThrow();
    });

    it("should accept valid port ranges", () => {
      expect(() => validateBootstrapServers("localhost:1")).not.toThrow();
      expect(() => validateBootstrapServers("localhost:65535")).not.toThrow();
      expect(() => validateBootstrapServers("localhost:8080")).not.toThrow();
    });

    it("should reject empty string", () => {
      expect(() => validateBootstrapServers("")).toThrow(
        "Value must be a non-empty string",
      );
    });

    it("should reject servers missing port", () => {
      expect(() => validateBootstrapServers("localhost")).toThrow(
        "Invalid format 'localhost': must be host:port",
      );
      expect(() => validateBootstrapServers("host1:9092,host2")).toThrow(
        "Invalid format 'host2': must be host:port",
      );
    });

    it("should reject servers missing host", () => {
      expect(() => validateBootstrapServers(":9092")).toThrow(
        "Invalid server ':9092': host cannot be empty",
      );
      expect(() => validateBootstrapServers("host1:9092,:9093")).toThrow(
        "Invalid server ':9093': host cannot be empty",
      );
    });

    it("should reject servers with invalid port (non-numeric)", () => {
      expect(() => validateBootstrapServers("localhost:abc")).toThrow(
        "Invalid server 'localhost:abc': port 'abc' is not numeric",
      );
      expect(() => validateBootstrapServers("localhost:90a92")).toThrow(
        "Invalid server 'localhost:90a92': port '90a92' contains non-numeric characters",
      );
    });

    it("should reject servers with port out of range", () => {
      expect(() => validateBootstrapServers("localhost:0")).toThrow(
        "Invalid server 'localhost:0': port 0 out of range (1-65535)",
      );
      expect(() => validateBootstrapServers("localhost:65536")).toThrow(
        "Invalid server 'localhost:65536': port 65536 out of range (1-65535)",
      );
      expect(() => validateBootstrapServers("localhost:-1")).toThrow(
        "Invalid server 'localhost:-1': port -1 out of range (1-65535)",
      );
      expect(() => validateBootstrapServers("localhost:99999")).toThrow(
        "Invalid server 'localhost:99999': port 99999 out of range (1-65535)",
      );
    });

    it("should reject servers with multiple colons", () => {
      expect(() => validateBootstrapServers("host:9092:extra")).toThrow(
        "Invalid format 'host:9092:extra': must be host:port",
      );
    });

    it("should reject non-string values", () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => validateBootstrapServers(null as any)).toThrow(
        "Value must be a non-empty string",
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => validateBootstrapServers(undefined as any)).toThrow(
        "Value must be a non-empty string",
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(() => validateBootstrapServers(123 as any)).toThrow(
        "Value must be a non-empty string",
      );
    });
  });
});
