import { describe, expect, it } from "vitest";
import {
  generateOpaqueToken,
  generateCodeVerifier,
  generateCodeChallenge,
} from "@src/confluent/oauth/crypto-utils.js";

describe("oauth/crypto-utils.ts", () => {
  describe("generateOpaqueToken", () => {
    it("should return a 64-character hex string", () => {
      const token = generateOpaqueToken();

      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it("should generate unique tokens on each call", () => {
      const token1 = generateOpaqueToken();
      const token2 = generateOpaqueToken();

      expect(token1).not.toBe(token2);
    });
  });

  describe("generateCodeVerifier", () => {
    it("should return a base64url-encoded string of appropriate length", () => {
      const verifier = generateCodeVerifier();

      // 32 bytes → 43 base64url characters (no padding)
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe("generateCodeChallenge", () => {
    it("should return a base64url-encoded SHA-256 hash of the verifier", () => {
      const verifier = generateCodeVerifier();
      const challenge = generateCodeChallenge(verifier);

      // SHA-256 → 32 bytes → 43 base64url characters
      expect(challenge.length).toBe(43);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it("should produce different challenges for different verifiers", () => {
      const challenge1 = generateCodeChallenge("verifier-1");
      const challenge2 = generateCodeChallenge("verifier-2");

      expect(challenge1).not.toBe(challenge2);
    });

    it("should produce the same challenge for the same verifier", () => {
      const verifier = "deterministic-verifier";
      const challenge1 = generateCodeChallenge(verifier);
      const challenge2 = generateCodeChallenge(verifier);

      expect(challenge1).toBe(challenge2);
    });
  });
});
