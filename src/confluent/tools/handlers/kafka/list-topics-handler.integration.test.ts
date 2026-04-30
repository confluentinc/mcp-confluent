import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
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

const handler = new ListTopicsHandler();
const runtime = integrationRuntime();

describe("list-topics-handler", { tags: [Tag.KAFKA] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires kafka.bootstrap_servers config", () => {});
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

    it("should expose list-topics in tools/list", async () => {
      const { tools } = await server.client.listTools();

      const listTopics = tools.find((t) => t.name === ToolName.LIST_TOPICS);
      expect(listTopics).toBeDefined();
    });

    it("should return the topics from the configured Kafka cluster", async () => {
      const result = await server.client.callTool({
        name: ToolName.LIST_TOPICS,
        arguments: {},
      });

      expect(result.isError).not.toBe(true);
      // handler response is always prefixed with "Kafka topics:" whether the
      // cluster is empty or not, so this proves the tool ran end-to-end
      expect(textContent(result)).toMatch(/^Kafka topics:/);
    });
  });
});
