import { SearchTopicsByNameHandler } from "@src/confluent/tools/handlers/search/search-topics-by-name-handler.js";
import {
  bareRuntime,
  confluentCloudRuntime,
  confluentCloudWithSchemaRegistryRuntime,
  DEFAULT_CONNECTION_ID,
  schemaRegistryRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("search-topics-by-name-handler.ts", () => {
  describe("SearchTopicsByNameHandler", () => {
    const handler = new SearchTopicsByNameHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID when both confluent_cloud and schema_registry blocks are present", () => {
        expect(
          handler.enabledConnectionIds(
            confluentCloudWithSchemaRegistryRuntime(),
          ),
        ).toEqual([DEFAULT_CONNECTION_ID]);
      });

      it("should return an empty array when only schema_registry block is present", () => {
        expect(handler.enabledConnectionIds(schemaRegistryRuntime())).toEqual(
          [],
        );
      });

      it("should return an empty array when only confluent_cloud block is present", () => {
        expect(handler.enabledConnectionIds(confluentCloudRuntime())).toEqual(
          [],
        );
      });

      it("should return an empty array when neither block is present", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });
    });
  });
});
