import { DeleteConnectorHandler } from "@src/confluent/tools/handlers/connect/delete-connector-handler.js";
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

const handler = new DeleteConnectorHandler();
const runtime = integrationRuntime();

describe(
  "delete-connector-handler",
  { tags: [Tag.CONNECT, Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG] },
  () => {
    if (handler.enabledConnectionIds(runtime).length === 0) {
      it.skip("requires confluent_cloud.auth config", () => {});
      return;
    }

    // installs afterAll at this describe scope (idempotent connector cleanup sweep)
    const { createdConnectors } = withSharedConnectorCleanup();

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should delete the provisioned connector via the tool", async () => {
        const connectorName = uniqueName(`connect-delete-${transport}`);
        createdConnectors.push(connectorName);
        await provisionTestDatagenConnector(connectorName);

        const result = await server.client.callTool({
          name: ToolName.DELETE_CONNECTOR,
          arguments: { connectorName },
        });

        expect(textContent(result)).toBe(
          `Successfully deleted connector ${connectorName}`,
        );
      });
    });
  },
);
