import { AddTagToTopicHandler } from "@src/confluent/tools/handlers/catalog/add-tags-to-topic.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  schemaRegistryRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("add-tags-to-topic.ts", () => {
  describe("AddTagToTopicHandler", () => {
    const handler = new AddTagToTopicHandler();

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
