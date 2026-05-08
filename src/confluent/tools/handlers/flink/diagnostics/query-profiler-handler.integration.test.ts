import { QueryProfilerHandler } from "@src/confluent/tools/handlers/flink/diagnostics/query-profiler-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  provisionTestFlinkStatement,
  waitForFlinkStatementPhase,
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

const handler = new QueryProfilerHandler();
const runtime = integrationRuntime();

describe("query-profiler-handler", { tags: [Tag.FLINK] }, () => {
  // composes hasFlink + hasTelemetry, stricter than the rest of the flink suite
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires flink + telemetry config", () => {});
    return;
  }

  // installs afterAll at this describe scope (cleans up the seeded statement)
  const { createdStatements } = withSharedFlinkStatementCleanup();
  const statementName = uniqueName("profile-stmt");

  beforeAll(async () => {
    await provisionTestFlinkStatement(statementName);
    createdStatements.push(statementName);
    // profiler reads the task graph, which only materializes once the statement is RUNNING
    await waitForFlinkStatementPhase(statementName, "RUNNING");
  });

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should expose get-flink-statement-profile in tools/list", async () => {
      const { tools } = await server.client.listTools();

      expect(
        tools.find((t) => t.name === ToolName.GET_FLINK_STATEMENT_PROFILE),
      ).toBeDefined();
    });

    it("should return a profiler report for the seeded statement", async () => {
      const result = await server.client.callTool({
        name: ToolName.GET_FLINK_STATEMENT_PROFILE,
        arguments: { statementName, includeAnalysis: false },
      });

      expect(textContent(result)).toMatch(
        new RegExp(`^Query Profiler for '${statementName}':`),
      );
    });
  });
});
