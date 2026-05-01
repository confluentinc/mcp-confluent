import { KafkaJS } from "@confluentinc/kafka-javascript";
import { ConsumeKafkaMessagesHandler } from "@src/confluent/tools/handlers/kafka/consume-kafka-messages-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  connectTestAdmin,
  connectTestProducer,
  uniqueTopicName,
} from "@tests/harness/kafka-admin.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ConsumeKafkaMessagesHandler();
const runtime = integrationRuntime();

describe("consume-kafka-messages-handler", { tags: [Tag.KAFKA] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires kafka.bootstrap_servers config", () => {});
    return;
  }

  // seed a shared test topic with messages (no need to split by transport)
  let admin: KafkaJS.Admin;
  let producer: KafkaJS.Producer;
  const topic = uniqueTopicName("consume");
  const seededValues = ["msg-0", "msg-1", "msg-2"];

  beforeAll(async () => {
    admin = await connectTestAdmin();
    await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] });
    producer = await connectTestProducer();
    await producer.send({
      topic,
      messages: seededValues.map((value) => ({ value })),
    });
  });

  afterAll(async () => {
    await producer.disconnect().catch(() => {
      // disconnect race during teardown isn't actionable
    });
    await admin.deleteTopics({ topics: [topic] }).catch(() => {
      // teardown-only; a cleanup failure shouldn't fail an already-asserted test
    });
    await admin.disconnect().catch(() => {
      // disconnect race during teardown isn't actionable
    });
  });

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should consume the seeded messages from the topic", async () => {
      const result = await server.client.callTool({
        name: ToolName.CONSUME_MESSAGES,
        arguments: {
          topicNames: [topic],
          maxMessages: seededValues.length,
          timeoutMs: 15_000,
          value: { useSchemaRegistry: false },
        },
      });

      expect(result.isError).not.toBe(true);

      const text = textContent(result);
      expect(text).toMatch(/^Consumed \d+ messages/);
      for (const value of seededValues) {
        expect(text).toContain(value);
      }
    });
  });
});
