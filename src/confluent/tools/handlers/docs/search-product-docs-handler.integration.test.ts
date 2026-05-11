import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface SearchPayload {
  results: Array<{ url: string; source: string }>;
  warnings: string[];
}

describe("search-product-docs-handler", { tags: [Tag.DOCS] }, () => {
  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should expose search-product-docs in tools/list", async () => {
      const { tools } = await server.client.listTools();
      expect(
        tools.find((t) => t.name === ToolName.SEARCH_PRODUCT_DOCS),
      ).toBeDefined();
    });

    // Non-empty results prove ≥1 backend responded and merge/dedupe ran.
    it("should return hits from at least one backend for a common query", async () => {
      const result = await server.client.callTool({
        name: ToolName.SEARCH_PRODUCT_DOCS,
        arguments: { query: "kafka topic configuration", limit: 5 },
      });

      expect(result.isError, textContent(result)).not.toBe(true);
      const payload = JSON.parse(textContent(result)) as SearchPayload;
      expect(payload.results.length).toBeGreaterThan(0);
      for (const hit of payload.results) {
        expect(hit.url).toMatch(
          /^https:\/\/(docs|developer|support)\.confluent\.io\//,
        );
      }
    });
  });
});
