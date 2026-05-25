import { GetConnectorStatusHandler } from "@src/confluent/tools/handlers/connect/get-connector-status-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  provisionTestDatagenConnector,
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

const handler = new GetConnectorStatusHandler();
const runtime = integrationRuntime();

describe(
  "get-connector-status-handler",
  { tags: [Tag.CONNECT, Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG] },
  () => {
    if (handler.enabledConnectionIds(runtime).length === 0) {
      it.skip("requires confluent_cloud.auth config", () => {});
      return;
    }

    // installs afterAll at this describe scope (test-side connector cleanup)
    const { createdConnectors } = withSharedConnectorCleanup();

    // provision once per file — same connector queried across all transport iterations
    let connectorName: string;
    beforeAll(async () => {
      connectorName = uniqueName("connect-status");
      createdConnectors.push(connectorName);
      await provisionTestDatagenConnector(connectorName);
    });

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose get-connector-status in tools/list", async () => {
        const { tools } = await server.client.listTools();
        expect(
          tools.find((t) => t.name === ToolName.GET_CONNECTOR_STATUS),
        ).toBeDefined();
      });

      it("should return status and surface lccId for the provisioned connector", async () => {
        const result = await server.client.callTool({
          name: ToolName.GET_CONNECTOR_STATUS,
          arguments: { connectorName },
        });

        const text = textContent(result);
        expect(text).toContain(`Connector Status for ${connectorName}:`);
        // expand=id surfaces the connector's resource ID as a top-level lccId
        expect(text).toMatch(/"lccId":"lcc-[a-z0-9]+"/);
      });
    });
  },
);
