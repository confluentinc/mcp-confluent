import { CreateTopicsHandler } from "@src/confluent/tools/handlers/kafka/create-topics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  uniqueTopicName,
  withSharedAdminClient,
} from "@tests/harness/kafka-admin.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new CreateTopicsHandler();
const runtime = integrationRuntime();

describe("create-topics-handler", { tags: [Tag.KAFKA] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires kafka.bootstrap_servers config", () => {});
    return;
  }

  // installs beforeAll/afterAll at this describe scope (shared admin client, topic cleanup)
  const { admin, createdTopics } = withSharedAdminClient();

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should create the requested Kafka topic", async () => {
      const topic = uniqueTopicName(`create-${transport}`);
      // track for cleanup before the call so a thrown callTool still enqueues
      // the topic for afterAll deletion if creation partially succeeded
      createdTopics.push(topic);

      const result = await server.client.callTool({
        name: ToolName.CREATE_TOPICS,
        arguments: { topics: [{ topic, numPartitions: 1 }] },
      });

      expect(result.isError).not.toBe(true);

      await expect
        .poll(() => admin().listTopics(), {
          timeout: 15_000,
          interval: 500,
        })
        .toContain(topic);
    });
  });
});
