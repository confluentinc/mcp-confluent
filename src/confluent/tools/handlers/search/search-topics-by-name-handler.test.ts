import { SearchTopicsByNameHandler } from "@src/confluent/tools/handlers/search/search-topics-by-name-handler.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  schemaRegistryRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("search-topics-by-name-handler.ts", () => {
  describe("SearchTopicsByNameHandler", () => {
    const handler = new SearchTopicsByNameHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with a schema_registry block", () => {
        expect(handler.enabledConnectionIds(schemaRegistryRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a schema_registry block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });
    });
  });
});
