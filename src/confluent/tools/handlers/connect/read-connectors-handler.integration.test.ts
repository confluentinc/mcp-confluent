import { ReadConnectorHandler } from "@src/confluent/tools/handlers/connect/read-connectors-handler.js";
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

const handler = new ReadConnectorHandler();
const runtime = integrationRuntime();

describe("read-connector-handler", { tags: [Tag.CONNECT] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires confluent_cloud.auth config", () => {});
    return;
  }

  // installs afterAll at this describe scope (test-side connector cleanup)
  const { createdConnectors } = withSharedConnectorCleanup();

  // provision once per file - same connector read across all transport iterations
  let connectorName: string;
  beforeAll(async () => {
    connectorName = uniqueName("connect-read");
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

    it("should expose read-connector in tools/list", async () => {
      const { tools } = await server.client.listTools();
      expect(
        tools.find((t) => t.name === ToolName.READ_CONNECTOR),
      ).toBeDefined();
    });

    it("should return details for the provisioned connector", async () => {
      const result = await server.client.callTool({
        name: ToolName.READ_CONNECTOR,
        arguments: { connectorName },
      });

      expect(textContent(result)).toContain(
        `Connector Details for ${connectorName}:`,
      );
    });
  });
});
