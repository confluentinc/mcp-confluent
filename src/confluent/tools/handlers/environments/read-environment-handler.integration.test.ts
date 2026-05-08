import { ReadEnvironmentHandler } from "@src/confluent/tools/handlers/environments/read-environment-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { getFirstTestEnvironmentId } from "@tests/harness/confluent-cloud.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ReadEnvironmentHandler();
const runtime = integrationRuntime();

describe("read-environment-handler", { tags: [Tag.ENVIRONMENTS] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires confluent_cloud.auth config", () => {});
    return;
  }

  // resolve once per file - same env id across all transport iterations
  let environmentId: string;
  beforeAll(async () => {
    environmentId = await getFirstTestEnvironmentId();
  });

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should expose read-environment in tools/list", async () => {
      const { tools } = await server.client.listTools();
      expect(
        tools.find((t) => t.name === ToolName.READ_ENVIRONMENT),
      ).toBeDefined();
    });

    it("should return details for the resolved environment id", async () => {
      const result = await server.client.callTool({
        name: ToolName.READ_ENVIRONMENT,
        arguments: { environmentId },
      });

      expect(textContent(result)).toContain(`ID: ${environmentId}`);
    });
  });
});
