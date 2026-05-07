import { ListConnectorsHandler } from "@src/confluent/tools/handlers/connect/list-connectors-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListConnectorsHandler();
const runtime = integrationRuntime();

describe("list-connectors-handler", { tags: [Tag.CONNECT] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires confluent_cloud.auth config", () => {});
    return;
  }

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should expose list-connectors in tools/list", async () => {
      const { tools } = await server.client.listTools();
      expect(
        tools.find((t) => t.name === ToolName.LIST_CONNECTORS),
      ).toBeDefined();
    });

    it("should return active connectors for the configured cluster", async () => {
      const result = await server.client.callTool({
        name: ToolName.LIST_CONNECTORS,
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      expect(textContent(result)).toMatch(/^Active Connectors:/);
    });
  });
});
