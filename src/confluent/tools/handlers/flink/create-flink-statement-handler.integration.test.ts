import { CreateFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/create-flink-statement-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { withSharedFlinkStatementCleanup } from "@tests/harness/flink.js";
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

const handler = new CreateFlinkStatementHandler();
const runtime = integrationRuntime();

describe("create-flink-statement-handler", { tags: [Tag.FLINK] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires flink config", () => {});
    return;
  }

  // installs afterAll at this describe scope (sweeps tool-created statements)
  const { createdStatements } = withSharedFlinkStatementCleanup();

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should expose create-flink-statement in tools/list", async () => {
      const { tools } = await server.client.listTools();

      expect(
        tools.find((t) => t.name === ToolName.CREATE_FLINK_STATEMENT),
      ).toBeDefined();
    });

    it("should create a SELECT 1 statement", async () => {
      const statementName = uniqueName("create-stmt");
      createdStatements.push(statementName);

      const result = await server.client.callTool({
        name: ToolName.CREATE_FLINK_STATEMENT,
        arguments: {
          statementName,
          statement: "SELECT 1;",
        },
      });

      // just check for the name since the handler returns the stringified JSON response
      expect(textContent(result)).toContain(`"name":"${statementName}"`);
    });
  });
});
