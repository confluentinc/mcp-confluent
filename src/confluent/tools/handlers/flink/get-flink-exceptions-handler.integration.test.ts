import { GetFlinkExceptionsHandler } from "@src/confluent/tools/handlers/flink/get-flink-exceptions-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  provisionTestFlinkStatement,
  withSharedFlinkStatementCleanup,
} from "@tests/harness/flink.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new GetFlinkExceptionsHandler();
const runtime = integrationRuntime();

describe("get-flink-exceptions-handler", { tags: [Tag.FLINK] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires flink config", () => {});
    return;
  }

  // installs afterAll at this describe scope (cleans up the seeded statement)
  const { createdStatements } = withSharedFlinkStatementCleanup();
  const statementName = uniqueName("exc-stmt");

  beforeAll(async () => {
    await provisionTestFlinkStatement(statementName);
    createdStatements.push(statementName);
  });

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should expose get-flink-statement-exceptions in tools/list", async () => {
      const { tools } = await server.client.listTools();

      expect(
        tools.find((t) => t.name === ToolName.GET_FLINK_STATEMENT_EXCEPTIONS),
      ).toBeDefined();
    });

    it("should return either an empty or populated exceptions response", async () => {
      const result = await server.client.callTool({
        name: ToolName.GET_FLINK_STATEMENT_EXCEPTIONS,
        arguments: { statementName },
      });

      expect(result.isError).not.toBe(true);
      // SELECT 1 typically completes cleanly, so accept either response shape
      expect(textContent(result)).toMatch(
        /^(No exceptions found|Flink Statement Exceptions)/,
      );
    });
  });
});
