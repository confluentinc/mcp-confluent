import { ListTagsHandler } from "@src/confluent/tools/handlers/catalog/list-tags.js";
import { runtimeWith } from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

describe("list-tags.ts", () => {
  describe("ListTagsHandler", () => {
    const handler = new ListTagsHandler();

    it("should resolve with the retrieved tags on success", async () => {
      const clientManager = getMockedClientManager();
      clientManager
        .getConfluentCloudSchemaRegistryRestClient()
        .GET.mockResolvedValue({ data: [{ name: "PII" }] });
      await assertHandleCase({
        handler,
        runtime: runtimeWith({}, "default", clientManager),
        outcome: { resolves: "Successfully retrieved tags" },
        clientManager,
      });
    });

    it("should resolve with an error response when the API returns an error", async () => {
      const clientManager = getMockedClientManager();
      clientManager
        .getConfluentCloudSchemaRegistryRestClient()
        .GET.mockResolvedValue({ error: { message: "boom" } });
      await assertHandleCase({
        handler,
        runtime: runtimeWith({}, "default", clientManager),
        outcome: { resolves: "Failed to list tags", isError: true },
        clientManager,
      });
    });
  });
});
