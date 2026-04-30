import { KafkaJS } from "@confluentinc/kafka-javascript";
import { GetTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/get-topic-config.js";
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
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new GetTopicConfigHandler();
const runtime = integrationRuntime();

const clusterId = Object.values(runtime.config.connections)[0]?.kafka
  ?.cluster_id;

describe("get-topic-config", { tags: [Tag.KAFKA] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires kafka.rest_endpoint + kafka.auth config", () => {});
    return;
  }

  // shared admin for cleanup of whatever topics each transport iteration creates
  let admin: KafkaJS.Admin;
  const createdTopics: string[] = [];

  beforeAll(async () => {
    admin = await connectTestAdmin();
  });

  afterAll(async () => {
    if (createdTopics.length > 0) {
      await admin.deleteTopics({ topics: createdTopics }).catch(() => {
        // teardown-only; a cleanup failure shouldn't fail an already-asserted test
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

    it("should return the topic configuration for an existing topic", async () => {
      const topic = uniqueTopicName(`get-config-${transport}`);
      createdTopics.push(topic);
      await admin.createTopics({ topics: [{ topic, numPartitions: 1 }] });

      const result = await server.client.callTool({
        name: ToolName.GET_TOPIC_CONFIG,
        arguments: {
          clusterId,
          topicName: topic,
        },
      });

      expect(result.isError).not.toBe(true);
      // handler embeds a JSON blob with both topicDetails and topicConfig
      const text = textContent(result);
      expect(text).toContain(`Topic configuration for '${topic}'`);
      expect(text).toContain("topicDetails");
      expect(text).toContain("topicConfig");
    });
  });
});
