import { CallToolResult } from "@src/confluent/schema.js";
import { READ_ONLY, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { TableflowToolHandler } from "@src/confluent/tools/handlers/tableflow/tableflow-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  bareRuntime,
  DEFAULT_CONNECTION_ID,
  tableflowRuntime,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

class StubTableflowHandler extends TableflowToolHandler {
  async handle(): Promise<CallToolResult> {
    return this.createResponse("stub");
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_TABLEFLOW_TOPICS,
      description: "stub",
      inputSchema: {},
      annotations: READ_ONLY,
    };
  }
}

describe("tableflow-tool-handler.ts", () => {
  describe("TableflowToolHandler", () => {
    const handler = new StubTableflowHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with a tableflow block", () => {
        expect(handler.enabledConnectionIds(tableflowRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a tableflow block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });
    });
  });
});
