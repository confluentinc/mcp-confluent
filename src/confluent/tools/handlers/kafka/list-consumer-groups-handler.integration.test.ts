import { ListConsumerGroupsHandler } from "@src/confluent/tools/handlers/kafka/list-consumer-groups-handler.js";
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

const handler = new ListConsumerGroupsHandler();
const runtime = integrationRuntime();

describe("list-consumer-groups-handler", { tags: [Tag.KAFKA] }, () => {
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

    it("should expose list-consumer-groups in tools/list", async () => {
      const { tools } = await server.client.listTools();

      const listConsumerGroups = tools.find(
        (t) => t.name === ToolName.LIST_CONSUMER_GROUPS,
      );
      expect(listConsumerGroups).toBeDefined();
    });

    it("should return the consumer groups from the configured Kafka cluster", async () => {
      const result = await server.client.callTool({
        name: ToolName.LIST_CONSUMER_GROUPS,
        arguments: {},
      });

      // handler always emits a "Found N consumer group(s)" prefix on the
      // text summary whether the cluster has zero groups or many, so this
      // proves the tool ran end-to-end against a real broker.
      expect(textContent(result)).toMatch(/^Found \d+ consumer group/);
    });
  });
});
