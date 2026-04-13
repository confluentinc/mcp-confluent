/**
 * Validates a Kafka bootstrap servers string.
 * Expects comma-separated host:port pairs where port is in range 1-65535.
 *
 * @param value - Bootstrap servers string (e.g., "localhost:9092" or "host1:9092,host2:9093")
 * @throws Error with specific message if validation fails
 */
export function validateBootstrapServers(value: string): void {
  if (!value || typeof value !== "string") {
    throw new Error("Value must be a non-empty string");
  }

  const servers = value.split(",").map((s) => s.trim());

  // Check for empty entries (trailing/consecutive commas)
  if (servers.includes("")) {
    throw new Error(
      "Invalid format: empty server entries (check for trailing or consecutive commas)",
    );
  }

  for (const server of servers) {
    // Must contain exactly one colon separating host and port
    const parts = server.split(":");
    if (parts.length !== 2) {
      throw new Error(`Invalid format '${server}': must be host:port`);
    }

    const [host, portStr] = parts;

    // Host must be non-empty
    if (!host || host.trim().length === 0) {
      throw new Error(`Invalid server '${server}': host cannot be empty`);
    }

    // Port must be non-empty and valid
    if (!portStr) {
      throw new Error(`Invalid server '${server}': port cannot be empty`);
    }

    // Port must be a valid integer in range 1-65535
    const port = Number.parseInt(portStr, 10);
    if (Number.isNaN(port)) {
      throw new TypeError(
        `Invalid server '${server}': port '${portStr}' is not numeric`,
      );
    }

    if (port < 1 || port > 65535) {
      throw new Error(
        `Invalid server '${server}': port ${port} out of range (1-65535)`,
      );
    }

    // Ensure port string is purely numeric (no trailing characters)
    if (port.toString() !== portStr) {
      throw new Error(
        `Invalid server '${server}': port '${portStr}' contains non-numeric characters`,
      );
    }
  }
}
