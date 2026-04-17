import { createHash, randomBytes } from "node:crypto";

/**
 * Generates a cryptographically secure opaque access token.
 * Returns a 64-character hex string (32 random bytes).
 */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Generates a PKCE code verifier (RFC 7636).
 * Returns a base64url-encoded string of 32 random bytes.
 */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Generates a PKCE code challenge from a code verifier (RFC 7636, S256 method).
 * Returns the base64url-encoded SHA-256 hash of the verifier.
 */
export function generateCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier).digest("base64url");
}
