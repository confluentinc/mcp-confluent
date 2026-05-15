import { createServer } from "node:net";

/**
 * Probes for a free TCP port by binding to port 0 on 127.0.0.1, reading the OS-assigned port, and
 * closing the socket. Used by the integration test harness so each test file can spawn its own HTTP
 * MCP server without colliding on a fixed port (relevant when a local dev server is already on
 * port 8080, or when vitest's forked-pool parallelism runs several test files at once).
 *
 * NOTE: there's potential race between `close()` and the test harness re-binding the port, but
 * for test parallelism on a single machine it shouldn't be an issue in practice
 */
export async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to resolve OS-assigned port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}
