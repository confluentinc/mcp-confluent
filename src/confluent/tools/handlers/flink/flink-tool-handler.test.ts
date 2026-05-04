import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { FlinkToolHandler } from "@src/confluent/tools/handlers/flink/flink-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  flinkRuntime,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

class StubFlinkHandler extends FlinkToolHandler {
  async handle(): Promise<CallToolResult> {
    return this.createResponse("stub");
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_FLINK_STATEMENTS,
      description: "stub",
      inputSchema: {},
      annotations: READ_ONLY,
    };
  }
}

describe("flink-tool-handler.ts", () => {
  describe("FlinkToolHandler", () => {
    const handler = new StubFlinkHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with a flink block", () => {
        expect(handler.enabledConnectionIds(flinkRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a flink block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });
    });

    describe("getFlinkDirectConfig()", () => {
      it("should return the flink block when present", () => {
        const runtime = flinkRuntime();
        const flink = handler["getFlinkDirectConfig"](runtime.config);
        expect(flink).toBe(runtime.config.getSoleConnection().flink);
      });

      it("should throw Wacky when the connection has no flink block", () => {
        expect(() =>
          handler["getFlinkDirectConfig"](bareRuntime().config),
        ).toThrow("Wacky --");
      });

      it("should throw Wacky when connection config is empty", () => {
        expect(() =>
          handler["getFlinkDirectConfig"](runtimeWith({}).config),
        ).toThrow("Wacky --");
      });
    });
  });
});
