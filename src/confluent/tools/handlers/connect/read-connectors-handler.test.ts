import { ReadConnectorHandler } from "@src/confluent/tools/handlers/connect/read-connectors-handler.js";
import {
  bareRuntime,
  confluentCloudRuntime,
  DEFAULT_CONNECTION_ID,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("read-connectors-handler.ts", () => {
  describe("ReadConnectorHandler", () => {
    const handler = new ReadConnectorHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with a confluent_cloud block", () => {
        expect(handler.enabledConnectionIds(confluentCloudRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a confluent_cloud block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });
    });
  });
});
