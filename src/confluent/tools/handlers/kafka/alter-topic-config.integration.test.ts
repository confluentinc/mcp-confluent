import { AlterTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/alter-topic-config.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  getTestClusterId,
  uniqueTopicName,
  withSharedAdminClient,
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

const handler = new AlterTopicConfigHandler();
const runtime = integrationRuntime();

describe("alter-topic-config", { tags: [Tag.KAFKA] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires kafka.rest_endpoint + kafka.auth config", () => {});
    return;
  }

  const clusterId = getTestClusterId();
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

    it("should alter retention.ms on the test topic via the REST proxy", async () => {
      const topic = uniqueTopicName(`alter-${transport}`);
      createdTopics.push(topic);
      await admin().createTopics({ topics: [{ topic, numPartitions: 1 }] });

      const result = await server.client.callTool({
        name: ToolName.ALTER_TOPIC_CONFIG,
        arguments: {
          clusterId,
          topicName: topic,
          topicConfigs: [
            {
              name: "retention.ms",
              value: "3600000",
              operation: "SET",
            },
          ],
          validateOnly: false,
        },
      });

      expect(result.isError).not.toBe(true);
      expect(textContent(result)).toMatch(/Successfully altered topic config/);
    });
  });
});
