import { ListFlinkStatementsHandler } from "@src/confluent/tools/handlers/flink/list-flink-statements-handler.js";
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

const handler = new ListFlinkStatementsHandler();
const runtime = integrationRuntime();

describe("list-flink-statements-handler", { tags: [Tag.FLINK] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires flink config", () => {});
    return;
  }

  // installs afterAll at this describe scope (tracks the seed statement for delete)
  const { createdStatements } = withSharedFlinkStatementCleanup();
  const seedName = uniqueName("list-stmts");

  beforeAll(async () => {
    await provisionTestFlinkStatement(seedName);
    createdStatements.push(seedName);
  });

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should expose list-flink-statements in tools/list", async () => {
      const { tools } = await server.client.listTools();

      expect(
        tools.find((t) => t.name === ToolName.LIST_FLINK_STATEMENTS),
      ).toBeDefined();
    });

    it("should return a JSON payload that includes the seeded statement", async () => {
      const result = await server.client.callTool({
        name: ToolName.LIST_FLINK_STATEMENTS,
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      // handler stringifies the raw response, so just check that the statement name appears
      expect(textContent(result)).toContain(seedName);
    });
  });
});
