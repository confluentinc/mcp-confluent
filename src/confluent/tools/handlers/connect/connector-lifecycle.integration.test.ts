import { PauseConnectorHandler } from "@src/confluent/tools/handlers/connect/pause-connector-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  provisionTestDatagenConnector,
  waitForConnectorRunnable,
  waitForConnectorRunning,
  withSharedConnectorCleanup,
} from "@tests/harness/connect.js";
import {
  integrationConnection,
  integrationDirectConnection,
} from "@tests/harness/runtime.js";
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

// All four lifecycle handlers share the same `hasConfluentCloud` predicate via
// ConnectToolHandler, so any one of them is representative for the predicate gate.
const handler = new PauseConnectorHandler();

describe(
  "connector-lifecycle",
  { tags: [Tag.CONNECT, Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG] },
  () => {
    if (skipIfDisabled(handler, integrationConnection())) {
      return;
    }

    // installs afterAll at this describe scope (test-side connector cleanup)
    const { createdConnectors } = withSharedConnectorCleanup();

    // Provision once per file. All four lifecycle ops are exercised against
    // the same connector across every transport iteration, since each op is
    // either idempotent (pause/resume) or tolerant of any source state
    // (restart/update-config full-replace). Wait for the connector to leave
    // PROVISIONING before any tests run — restart in particular is 400'd
    // while the connector is still spinning up.
    let connectorName: string;
    beforeAll(async () => {
      connectorName = uniqueName("connect-lifecycle");
      createdConnectors.push(connectorName);
      await provisionTestDatagenConnector(connectorName);
      await waitForConnectorRunnable(connectorName);
    }, 90_000);

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose the four lifecycle tools in tools/list", async () => {
        const { tools } = await server.client.listTools();
        const names = new Set(tools.map((t) => t.name));
        expect(names.has(ToolName.PAUSE_CONNECTOR)).toBe(true);
        expect(names.has(ToolName.RESUME_CONNECTOR)).toBe(true);
        expect(names.has(ToolName.RESTART_CONNECTOR)).toBe(true);
        expect(names.has(ToolName.UPDATE_CONNECTOR_CONFIG)).toBe(true);
      });

      it("should pause the connector", async () => {
        const result = await server.client.callTool({
          name: ToolName.PAUSE_CONNECTOR,
          arguments: { connectorName },
        });
        expect(textContent(result)).toBe(
          `Pause requested for connector ${connectorName}.`,
        );
      });

      it("should resume the connector", async () => {
        const result = await server.client.callTool({
          name: ToolName.RESUME_CONNECTOR,
          arguments: { connectorName },
        });
        expect(textContent(result)).toBe(
          `Resume requested for connector ${connectorName}.`,
        );
      });

      it("should restart the connector", async () => {
        // Resume returns 202 the moment CCloud accepts the request; the state
        // transition itself is asynchronous, so the connector may still be
        // PAUSED when this test fires. Restart is rejected with HTTP 400 on
        // a non-RUNNING connector, so wait for the resume to actually land
        // before issuing the restart.
        await waitForConnectorRunning(connectorName);

        const result = await server.client.callTool({
          name: ToolName.RESTART_CONNECTOR,
          arguments: { connectorName },
        });
        expect(textContent(result)).toBe(
          `Restart requested for connector ${connectorName}.`,
        );
      });

      it("should replace the connector config via update-connector-config", async () => {
        // PUT /config is full-replace, so the body must carry every key
        // the connector class requires. We re-send the provisioning shape
        // with `quickstart` flipped from "USERS" to "ORDERS"
        // asserting the response echoes the new value to prove the
        // round-trip applied.
        const conn = integrationDirectConnection();
        const auth = conn.kafka?.auth;
        expect(
          auth,
          "kafka.auth is required to compose the update-config body",
        ).toBeDefined();

        const result = await server.client.callTool({
          name: ToolName.UPDATE_CONNECTOR_CONFIG,
          arguments: {
            connectorName,
            connectorConfig: {
              "connector.class": "DatagenSource",
              name: connectorName,
              "kafka.api.key": auth!.key,
              "kafka.api.secret": auth!.secret,
              "kafka.topic": connectorName,
              quickstart: "ORDERS",
              "tasks.max": "1",
              "output.data.format": "JSON",
            },
          },
        });

        const text = textContent(result);
        expect(text).toContain(`${connectorName} config updated:`);
        expect(text).toContain('"quickstart":"ORDERS"');
      });
    });
  },
);
