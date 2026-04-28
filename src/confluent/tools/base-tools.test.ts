import { type CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  type ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import type { EnvVar } from "@src/env-schema.js";
import { envFactory } from "@tests/factories/env.js";
import { runtimeWith } from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

class StubHandler extends BaseToolHandler {
  constructor(private readonly vars: readonly EnvVar[]) {
    super();
  }

  getRequiredEnvVars(): readonly EnvVar[] {
    return this.vars;
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.LIST_TOPICS,
      description: "stub",
      inputSchema: {},
      annotations: READ_ONLY,
    };
  }

  handle(): CallToolResult {
    return this.createResponse("stub");
  }
}

describe("BaseToolHandler", () => {
  describe("enabledConnectionIds()", () => {
    it("should return the connection ID when all required env vars are present", () => {
      const handler = new StubHandler(["KAFKA_API_KEY", "KAFKA_API_SECRET"]);
      const runtime = runtimeWith(
        envFactory({ KAFKA_API_KEY: "key", KAFKA_API_SECRET: "secret" }),
      );
      expect(handler.enabledConnectionIds(runtime)).toEqual(["default"]);
    });

    it("should return an empty array when a required env var is missing", () => {
      const handler = new StubHandler(["KAFKA_API_KEY", "KAFKA_API_SECRET"]);
      const runtime = runtimeWith(envFactory({ KAFKA_API_KEY: "key" }));
      expect(handler.enabledConnectionIds(runtime)).toEqual([]);
    });

    it("should return an empty array when all required env vars are missing", () => {
      const handler = new StubHandler(["KAFKA_API_KEY", "KAFKA_API_SECRET"]);
      const runtime = runtimeWith(envFactory());
      expect(handler.enabledConnectionIds(runtime)).toEqual([]);
    });

    it("should return the connection ID when getRequiredEnvVars returns an empty array", () => {
      const handler = new StubHandler([]);
      const runtime = runtimeWith(envFactory());
      expect(handler.enabledConnectionIds(runtime)).toEqual(["default"]);
    });
  });
});
