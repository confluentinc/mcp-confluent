import { DetectIssuesHandler } from "@src/confluent/tools/handlers/flink/diagnostics/detect-issues-handler.js";
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

const handler = new DetectIssuesHandler();
const runtime = integrationRuntime();

describe("detect-issues-handler", { tags: [Tag.FLINK] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires flink config", () => {});
    return;
  }

  // installs afterAll at this describe scope (cleans up the seeded statement)
  const { createdStatements } = withSharedFlinkStatementCleanup();
  const statementName = uniqueName("issues-stmt");

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

    it("should expose detect-flink-statement-issues in tools/list", async () => {
      const { tools } = await server.client.listTools();

      expect(
        tools.find((t) => t.name === ToolName.DETECT_FLINK_STATEMENT_ISSUES),
      ).toBeDefined();
    });

    it("should return an issue report for the seeded statement", async () => {
      // includeMetrics: false skips the Telemetry roundtrip
      const result = await server.client.callTool({
        name: ToolName.DETECT_FLINK_STATEMENT_ISSUES,
        arguments: { statementName, includeMetrics: false },
      });

      expect(result.isError).not.toBe(true);
      // SELECT 1 typically reports no issues; accept either response prefix.
      expect(textContent(result)).toMatch(
        new RegExp(
          `(No issues detected|Detected \\d+ issue).*'${statementName}'`,
        ),
      );
    });
  });
});
