import { ListEnvironmentsHandler } from "@src/confluent/tools/handlers/environments/list-environments-handler.js";
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

const handler = new ListEnvironmentsHandler();
const runtime = integrationRuntime();

describe("list-environments-handler", { tags: [Tag.ENVIRONMENTS] }, () => {
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

    it("should expose list-environments in tools/list", async () => {
      const { tools } = await server.client.listTools();
      expect(
        tools.find((t) => t.name === ToolName.LIST_ENVIRONMENTS),
      ).toBeDefined();
    });

    it("should return at least one environment from CCloud", async () => {
      const result = await server.client.callTool({
        name: ToolName.LIST_ENVIRONMENTS,
        arguments: {},
      });

      // handler's success line starts with "Successfully retrieved N environments:"
      expect(textContent(result)).toMatch(
        /^Successfully retrieved \d+ environments:/,
      );
    });
  });
});
