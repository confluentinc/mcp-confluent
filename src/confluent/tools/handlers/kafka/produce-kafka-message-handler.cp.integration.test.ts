import { KafkaJS } from "@confluentinc/kafka-javascript";
import { ProduceKafkaMessageHandler } from "@src/confluent/tools/handlers/kafka/produce-kafka-message-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  connectCpTestAdmin,
  uniqueCpTopicName,
} from "@tests/harness/cp-kafka-admin.js";
import { cpIntegrationRuntime } from "@tests/harness/cp-runtime.js";
import {
  startCpServer,
  type StartedServer,
} from "@tests/harness/cp-start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ProduceKafkaMessageHandler();
const runtime = cpIntegrationRuntime();

describe(
  "produce-kafka-message-handler (Confluent Platform)",
  { tags: [Tag.CP] },
  () => {
    if (handler.enabledConnectionIds(runtime).length === 0) {
      it.skip("requires kafka.bootstrap_servers config (start docker-compose.cp-test.yml and set CP_KAFKA_USERNAME + CP_KAFKA_PASSWORD)", () => {});
      return;
    }

    // single shared topic for all transports (cheaper than creating one per transport)
    let admin: KafkaJS.Admin;
    const topic = uniqueCpTopicName("produce");

    beforeAll(async () => {
      admin = await connectCpTestAdmin();
      await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] });
    });

    afterAll(async () => {
      await admin.deleteTopics({ topics: [topic] }).catch(() => {
        // teardown-only; a cleanup failure shouldn't fail an already-asserted test
      });
      await admin.disconnect();
    });

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startCpServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should produce a message to the CP cluster and return a delivery report", async () => {
        const result = await server.client.callTool({
          name: ToolName.PRODUCE_MESSAGE,
          arguments: {
            topicName: topic,
            value: { message: `hello from CP via ${transport}` },
          },
        });

        expect(result.isError).not.toBe(true);
        // handler formats each delivery report as:
        //   "Message produced successfully to [Topic: ..., Partition: ..., Offset: ...]"
        const text = textContent(result);
        expect(text).toMatch(/Message produced successfully to \[Topic: /);
        expect(text).toContain(topic);
      });
    });
  },
);
