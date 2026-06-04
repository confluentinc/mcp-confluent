import { DeleteFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/delete-flink-statement-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  provisionTestFlinkStatement,
  withSharedFlinkStatementCleanup,
} from "@tests/harness/flink.js";
import { integrationConnection } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new DeleteFlinkStatementHandler();

describe(
  "delete-flink-statement-handler",
  {
    tags: [
      Tag.FLINK,
      Tag.REQUIRES_FLINK_CONFIG,
      Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG,
    ],
  },
  () => {
    const verdict = handler.predicate(integrationConnection());
    if (!verdict.enabled) {
      it.skip(verdict.reason, () => {});
      return;
    }

    // installs afterAll at this describe scope (sweeps any leftover tracked statements)
    const { createdStatements } = withSharedFlinkStatementCleanup();

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose delete-flink-statements in tools/list", async () => {
        const { tools } = await server.client.listTools();

        expect(
          tools.find((t) => t.name === ToolName.DELETE_FLINK_STATEMENTS),
        ).toBeDefined();
      });

      it("should delete a test-side provisioned statement", async () => {
        const statementName = uniqueName("delete-stmt");
        // track first so a failure mid-create still gets swept by afterAll
        createdStatements.push(statementName);
        await provisionTestFlinkStatement(statementName);

        const result = await server.client.callTool({
          name: ToolName.DELETE_FLINK_STATEMENTS,
          arguments: { statementName },
        });

        expect(textContent(result)).toMatch(
          /^Flink SQL Statement Deletion Status Code:/,
        );
      });
    });
  },
);
