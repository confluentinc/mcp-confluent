import { randomBytes, timingSafeEqual } from "crypto";
import { FastifyReply, FastifyRequest } from "fastify";
import { logger } from "@src/logger.js";

/**
 * Configuration for MCP server authentication
 */
export interface AuthConfig {
  /** API key for authentication */
  apiKey: string;
  /** Whether authentication is enabled */
  enabled: boolean;
  /** List of allowed Host header values for DNS rebinding protection */
  allowedHosts: string[];
}

/**
 * Generates a cryptographically secure random API key
 * @returns 64-character hex string
 */
export function generateApiKey(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Timing-safe comparison of API keys to prevent timing attacks
 */
function secureCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  // If lengths differ, still do comparison to prevent timing leak
  if (bufA.length !== bufB.length) {
    // Compare against self to maintain constant time
    timingSafeEqual(bufA, bufA);
    return false;
  }

  return timingSafeEqual(bufA, bufB);
}

/**
 * Extracts hostname from Host header using URL parsing
 * Handles IPv4, IPv6, and regular hostnames correctly
 */
function parseHostname(hostHeader: string): string | null {
  try {
    // Prepend dummy protocol since URL requires one
    const url = new URL(`http://${hostHeader}`);
    return url.hostname.toLowerCase();
  } catch {
    // Invalid host header format
    return null;
  }
}

/**
 * Validates the Host header against allowed hosts list
 * Used for DNS rebinding protection
 */
function isHostAllowed(
  hostHeader: string | undefined,
  allowedHosts: string[],
): boolean {
  if (!hostHeader) {
    return false;
  }

  const hostname = parseHostname(hostHeader);
  if (!hostname) {
    return false;
  }

  return allowedHosts.some((allowed) => {
    const allowedLower = allowed.toLowerCase();
    // Exact match on hostname (e.g., "localhost" matches "localhost:8080")
    if (hostname === allowedLower) {
      return true;
    }
    // Allow matching with port in allowed list (e.g., "localhost:8080")
    if (hostHeader.toLowerCase() === allowedLower) {
      return true;
    }
    return false;
  });
}

/**
 * Creates Fastify onRequest hook for authentication and host validation
 * @param config Authentication configuration
 * @returns Fastify hook function
 */
export function createAuthHook(config: AuthConfig) {
  return async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> => {
    // 1. ALWAYS validate Host header (DNS rebinding protection)
    // This runs regardless of whether API key auth is enabled
    const hostHeader = request.headers.host;
    if (!isHostAllowed(hostHeader, config.allowedHosts)) {
      logger.warn(
        { host: hostHeader },
        "Request rejected: Invalid Host header",
      );
      reply.status(403).send({
        error: "Forbidden",
        message: "Invalid Host header",
      });
      return;
    }

    // 2. Skip API key auth if disabled
    if (!config.enabled) {
      logger.debug("API key authentication disabled, skipping API key check");
      return;
    }

    // 3. Validate API Key (header names are lowercased by Fastify)
    const apiKey = request.headers["cflt-mcp-api-key"];

    if (!apiKey || typeof apiKey !== "string") {
      logger.warn("Request rejected: Missing cflt-mcp-api-Key header");
      reply.status(401).send({
        error: "Unauthorized",
        message: "Missing cflt-mcp-api-Key header",
      });
      return;
    }

    if (!secureCompare(apiKey, config.apiKey)) {
      logger.warn("Request rejected: Invalid API key");
      reply.status(401).send({
        error: "Unauthorized",
        message: "Invalid API key",
      });
      return;
    }

    logger.debug("Request authenticated successfully");
  };
}

/**
 * Error response schemas for OpenAPI documentation
 */
export const authErrorSchemas = {
  unauthorized: {
    type: "object",
    properties: {
      error: { type: "string", example: "Unauthorized" },
      message: { type: "string", example: "Missing cflt-mcp-api-Key header" },
    },
  },
  forbidden: {
    type: "object",
    properties: {
      error: { type: "string", example: "Forbidden" },
      message: { type: "string", example: "Invalid Host header" },
    },
  },
};
