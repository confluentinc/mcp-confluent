import { CreateConnectorHandler } from "@src/confluent/tools/handlers/connect/create-connector-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { withSharedConnectorCleanup } from "@tests/harness/connect.js";
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

const handler = new CreateConnectorHandler();

describe(
  "create-connector-handler",
  { tags: [Tag.CONNECT, Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG] },
  () => {
    const verdict = handler.predicate(integrationConnection());
    if (!verdict.enabled) {
      it.skip(verdict.reason, () => {});
      return;
    }

    // installs afterAll at this describe scope (test-side connector cleanup)
    const { createdConnectors } = withSharedConnectorCleanup();

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should create a Datagen Source connector via the tool", async () => {
        const connectorName = uniqueName(`connect-create-${transport}`);
        // track for cleanup before the call so partial creation still gets swept
        createdConnectors.push(connectorName);

        const result = await server.client.callTool({
          name: ToolName.CREATE_CONNECTOR,
          arguments: {
            connectorName,
            connectorConfig: {
              "connector.class": "DatagenSource",
              "kafka.topic": connectorName,
              quickstart: "USERS",
              "tasks.max": "1",
              "output.data.format": "JSON",
            },
          },
        });

        expect(textContent(result)).toContain(`${connectorName} created:`);
      });
    });
  },
);
