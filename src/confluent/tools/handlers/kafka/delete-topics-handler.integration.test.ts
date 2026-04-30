import { KafkaJS } from "@confluentinc/kafka-javascript";
import { DeleteTopicsHandler } from "@src/confluent/tools/handlers/kafka/delete-topics-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  connectTestAdmin,
  uniqueTopicName,
} from "@tests/harness/kafka-admin.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new DeleteTopicsHandler();
const runtime = integrationRuntime();

describe("delete-topics-handler", { tags: [Tag.KAFKA] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires kafka.bootstrap_servers config", () => {});
    return;
  }

  // the admin client pre-creates topics for the handler to delete, and cleans up any that the
  // handler failed to remove
  let admin: KafkaJS.Admin;
  const createdTopics: string[] = [];

  beforeAll(async () => {
    admin = await connectTestAdmin();
  });

  afterAll(async () => {
    if (createdTopics.length > 0) {
      await admin.deleteTopics({ topics: createdTopics }).catch(() => {
        // the handler-under-test already deleted these on success; ignore any not-found errors
      });
    }
    await admin.disconnect();
  });

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should delete the requested Kafka topic", async () => {
      const topic = uniqueTopicName(`delete-${transport}`);
      createdTopics.push(topic);
      await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] });
      // wait for the newly-created topic to be visible before deleting it
      await expect
        .poll(() => admin.listTopics(), {
          timeout: 15_000,
          interval: 500,
        })
        .toContain(topic);

      const result = await server.client.callTool({
        name: ToolName.DELETE_TOPICS,
        arguments: { topicNames: [topic] },
      });

      expect(result.isError).not.toBe(true);

      await expect
        .poll(() => admin.listTopics(), {
          timeout: 15_000,
          interval: 500,
        })
        .not.toContain(topic);
    });
  });
});
