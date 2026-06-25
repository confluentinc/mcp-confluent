import { GetFlinkStatementResultsHandler } from "@src/confluent/tools/handlers/flink/get-flink-statement-results-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  provisionTestFlinkStatement,
  withSharedFlinkStatementCleanup,
} from "@tests/harness/flink.js";
import { integrationConnection } from "@tests/harness/runtime.js";
import { skipIfDisabled } from "@tests/harness/skip-gate.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new GetFlinkStatementResultsHandler();

describe(
  "get-flink-statement-results-handler",
  {
    tags: [
      Tag.FLINK,
      Tag.REQUIRES_FLINK_CONFIG,
      Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG,
    ],
  },
  () => {
    if (skipIfDisabled(handler, integrationConnection())) {
      return;
    }

    // installs afterAll at this describe scope (cleans up the seeded statement)
    const { createdStatements } = withSharedFlinkStatementCleanup();
    const statementName = uniqueName("get-stmt-results");

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

      it("should expose get-flink-statement-results in tools/list", async () => {
        const { tools } = await server.client.listTools();

        expect(
          tools.find((t) => t.name === ToolName.GET_FLINK_STATEMENT_RESULTS),
        ).toBeDefined();
      });

      it("should fetch the seeded statement results and return a results header", async () => {
        // CCloud briefly returns 409 "Results not ready" between statement creation time and the time
        // results are available
        await expect
          .poll(
            async () => {
              const result = await server.client.callTool({
                name: ToolName.GET_FLINK_STATEMENT_RESULTS,
                arguments: { statementName, timeoutInMilliseconds: 5000 },
              });
              return textContent(result);
            },
            { timeout: 30_000, interval: 2_000 },
          )
          .toMatch(/^Flink SQL Statement Results:/);
      });
    });
  },
);
