import { GetConnectorErrorSummaryHandler } from "@src/confluent/tools/handlers/connect/get-connector-error-summary-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  provisionFailedTestPostgresConnector,
  provisionTestDatagenConnector,
  waitForConnectorFailed,
  waitForConnectorRunning,
  withSharedConnectorCleanup,
} from "@tests/harness/connect.js";
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

// All three error-diagnostics handlers share the same `hasConfluentCloud`
// predicate via ConnectToolHandler, so any one is representative for the
// predicate gate.
const handler = new GetConnectorErrorSummaryHandler();
const runtime = integrationRuntime();

describe(
  "connector-error-diagnostics",
  { tags: [Tag.CONNECT, Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG] },
  () => {
    if (handler.enabledConnectionIds(runtime).length === 0) {
      it.skip("requires confluent_cloud.auth config", () => {});
      return;
    }

    // installs afterAll at this describe scope (test-side connector cleanup)
    const { createdConnectors } = withSharedConnectorCleanup();

    // Two connectors per file, provisioned in parallel:
    //
    // - **failedConnectorName** — PostgresSource pointed at a non-resolvable
    //   hostname. CCloud accepts the config at POST, then the source task
    //   fails during config validation when the JDBC driver can't reach the
    //   host. The connector enters FAILED with populated `validation_errors`
    //   that the error-summary / error-recommendations tools project.
    //
    // - **healthyConnectorName** — Datagen Source in steady-state RUNNING.
    //   Used exclusively for the logs test: ERROR-level logs are absent for a
    //   healthy connector, but INFO-level lifecycle messages are emitted by
    //   the task scheduler and surface within ~10s of task start. The FAILED
    //   PostgresSource above never started a task, so its logs window is
    //   empty regardless of level — which is why the logs tool needs a
    //   different, healthy source to exercise.
    let failedConnectorName: string;
    let healthyConnectorName: string;
    beforeAll(async () => {
      failedConnectorName = uniqueName("connect-errdiag-failed");
      healthyConnectorName = uniqueName("connect-errdiag-healthy");
      createdConnectors.push(failedConnectorName, healthyConnectorName);
      await Promise.all([
        provisionFailedTestPostgresConnector(failedConnectorName),
        provisionTestDatagenConnector(healthyConnectorName),
      ]);
      await Promise.all([
        waitForConnectorFailed(failedConnectorName),
        waitForConnectorRunning(healthyConnectorName),
      ]);
    }, 240_000);

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose the three error-diagnostics tools in tools/list", async () => {
        const { tools } = await server.client.listTools();
        const names = new Set(tools.map((t) => t.name));
        expect(names.has(ToolName.GET_CONNECTOR_ERROR_SUMMARY)).toBe(true);
        expect(names.has(ToolName.GET_CONNECTOR_ERROR_RECOMMENDATIONS)).toBe(
          true,
        );
        expect(names.has(ToolName.GET_CONNECTOR_LOGS)).toBe(true);
      });

      it("should project FAILED state with error diagnostics in error-summary", async () => {
        const result = await server.client.callTool({
          name: ToolName.GET_CONNECTOR_ERROR_SUMMARY,
          arguments: { connectorName: failedConnectorName },
        });
        const text = textContent(result);
        expect(text).toContain(`Error summary for ${failedConnectorName}:`);
        // Don't pin the exact projection shape — Cloud's error_summary may
        // evolve. The presence of these key fields proves the projection
        // populated against a real FAILED connector instead of bailing out
        // on the healthy short-circuit.
        expect(text).toContain('"hasError":true');
        expect(text).toContain('"state":"FAILED"');
      });

      it("should surface recommendations (or the friendly fallback) for the failed connector", async () => {
        const result = await server.client.callTool({
          name: ToolName.GET_CONNECTOR_ERROR_RECOMMENDATIONS,
          arguments: { connectorName: failedConnectorName },
        });
        const text = textContent(result);
        // Two acceptable shapes: Cloud has generated recommendations from the
        // failure trace (populated path) or Cloud hasn't captured a stack
        // trace yet (the friendly 400 → "No error recommendations" path).
        // Both prove the round-trip works.
        const populated = text.startsWith(
          `Error recommendations for ${failedConnectorName}:`,
        );
        const fallback =
          text ===
          `No error recommendations available for connector ${failedConnectorName}.`;
        expect(
          populated || fallback,
          `unexpected get-connector-error-recommendations response: ${text}`,
        ).toBe(true);
      });

      it("should retrieve INFO-level logs for the healthy Datagen connector via the token-exchange flow", async () => {
        // Exercises both legs of the auth handshake: POST /api/access_tokens
        // (Basic → Bearer), then POST /logs/v1/search (Bearer → results).
        // INFO-level lifecycle messages (task start, config load) populate
        // within ~10s of the Datagen task transitioning to RUNNING.
        // ERROR-only would return an empty window here — INFO is what
        // proves the logs API actually returned entries.
        const result = await server.client.callTool({
          name: ToolName.GET_CONNECTOR_LOGS,
          arguments: {
            connectorName: healthyConnectorName,
            levels: ["INFO"],
            pageSize: 5,
          },
        });
        const text = textContent(result);
        // Cloud's logging pipeline can lag a few seconds behind the
        // connector's actual task lifecycle. Accept either the empty-window
        // one-liner or the populated projection — both prove the auth flow
        // and search request succeeded; the empty path simply means the
        // pipeline hadn't surfaced the task-start entry yet.
        const empty = text.startsWith(
          `No log entries for connector ${healthyConnectorName}`,
        );
        const populated =
          text.startsWith(`Logs for ${healthyConnectorName}:`) &&
          text.includes('"level":"INFO"');
        expect(
          empty || populated,
          `unexpected get-connector-logs response: ${text}`,
        ).toBe(true);
      });
    });
  },
);
