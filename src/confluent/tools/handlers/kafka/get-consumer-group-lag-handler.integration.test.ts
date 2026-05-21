import { KafkaJS } from "@confluentinc/kafka-javascript";
import {
  GetConsumerGroupLagHandler,
  type GetConsumerGroupLagResponse,
} from "@src/confluent/tools/handlers/kafka/get-consumer-group-lag-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  connectTestAdmin,
  connectTestConsumer,
  connectTestProducer,
} from "@tests/harness/kafka-admin.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new GetConsumerGroupLagHandler();
const runtime = integrationRuntime();

const NUM_PARTITIONS = 3;
const SEEDED_MESSAGE_COUNT = 10;
const COMMITTED_OFFSET = 4;
const EXPECTED_LAG = SEEDED_MESSAGE_COUNT - COMMITTED_OFFSET;

describe(
  "get-consumer-group-lag-handler",
  { tags: [Tag.KAFKA, Tag.REQUIRES_KAFKA_CONFIG] },
  () => {
    if (handler.enabledConnectionIds(runtime).length === 0) {
      it.skip("requires kafka.bootstrap_servers config", () => {});
      return;
    }

    let admin: KafkaJS.Admin;
    let producer: KafkaJS.Producer;
    const topic = uniqueName("lag");
    // Second topic stays exist-but-untouched so below can prove the
    // "filter includes a topic the group has never committed to" path returns
    // `partitions: []` rather than silently dropping the topic.
    const untouchedTopic = uniqueName("lag-untouched");
    const groupId = uniqueName("lag-group");

    beforeAll(async () => {
      admin = await connectTestAdmin();
      await admin.createTopics({
        topics: [
          { topic, numPartitions: NUM_PARTITIONS },
          { topic: untouchedTopic, numPartitions: 1 },
        ],
      });
      producer = await connectTestProducer();
      // Pin every seed write to partition 0 so the per-partition lag
      // assertion below compares against an exact known number rather than
      // a sum across whatever partition the default hash picked.
      await producer.send({
        topic,
        messages: Array.from({ length: SEEDED_MESSAGE_COUNT }, (_, i) => ({
          value: `msg-${i}`,
          partition: 0,
        })),
      });

      // Bind a consumer instance to the test groupId and write the committed
      // offset explicitly. `commitOffsets([...])` with explicit
      // topic-partition-offsets writes to the __consumer_offsets topic via
      // the group coordinator regardless of whether the consumer has been
      // subscribed or assigned anything — no poll loop or rebalance needed.
      const consumer = await connectTestConsumer(groupId);
      try {
        await consumer.commitOffsets([
          { topic, partition: 0, offset: String(COMMITTED_OFFSET) },
        ]);
      } finally {
        await consumer.disconnect().catch(() => {
          // disconnect race during fixture teardown isn't actionable
        });
      }
    });

    afterAll(async () => {
      await producer.disconnect().catch(() => {
        // disconnect race during teardown isn't actionable
      });
      // Best-effort group cleanup — leaves the broker in the state CI expects
      // (no orphaned `int-lag-group-*` groups accumulating across runs).
      // `deleteGroups` may reject if the group already has live members, but
      // we disconnected the only consumer above so that shouldn't fire.
      await admin.deleteGroups([groupId]).catch(() => {
        // teardown-only; a cleanup failure shouldn't fail an already-asserted test
      });
      await admin
        .deleteTopics({ topics: [topic, untouchedTopic] })
        .catch(() => {
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

      it("should expose get-consumer-group-lag in tools/list", async () => {
        const { tools } = await server.client.listTools();
        const tool = tools.find(
          (t) => t.name === ToolName.GET_CONSUMER_GROUP_LAG,
        );
        expect(tool).toBeDefined();
      });

      it("should return the deterministic lag for the seeded group on the seeded topic", async () => {
        const result = await server.client.callTool({
          name: ToolName.GET_CONSUMER_GROUP_LAG,
          arguments: { groupId },
        });

        expect(result.isError, textContent(result)).not.toBe(true);
        const payload = result.structuredContent as GetConsumerGroupLagResponse;
        expect(payload.groupId).toBe(groupId);
        // Group committed to partition 0 of `topic` only, so the response
        // carries exactly one topic with exactly one partition row — the other
        // partitions never received a commit and are absent from the
        // fetchOffsets response (distinct from the `offset === "-1"` rewound
        // case the unit suite covers).
        expect(payload.topics).toHaveLength(1);
        const topicEntry = payload.topics[0]!;
        expect(topicEntry.topic).toBe(topic);
        expect(topicEntry.partitions).toHaveLength(1);
        expect(topicEntry.partitions[0]).toMatchObject({
          partition: 0,
          committedOffset: String(COMMITTED_OFFSET),
          highWatermark: String(SEEDED_MESSAGE_COUNT),
          lag: EXPECTED_LAG,
        });
        expect(payload.totalLag).toBe(EXPECTED_LAG);
        expect(textContent(result)).toContain(
          `Consumer group "${groupId}" has ${EXPECTED_LAG} message(s) of lag across 1 topic(s).`,
        );
      });

      it("should narrow the response to the requested topic when a topics filter is supplied", async () => {
        const result = await server.client.callTool({
          name: ToolName.GET_CONSUMER_GROUP_LAG,
          arguments: { groupId, topics: [topic] },
        });

        expect(result.isError, textContent(result)).not.toBe(true);
        const payload = result.structuredContent as GetConsumerGroupLagResponse;
        expect(payload.topics).toHaveLength(1);
        expect(payload.topics[0]!.topic).toBe(topic);
        expect(payload.totalLag).toBe(EXPECTED_LAG);
      });

      it("should include a never-committed-but-existing topic as {topic, partitions: []} when present in the filter", async () => {
        const result = await server.client.callTool({
          name: ToolName.GET_CONSUMER_GROUP_LAG,
          arguments: { groupId, topics: [topic, untouchedTopic] },
        });

        expect(result.isError, textContent(result)).not.toBe(true);
        const payload = result.structuredContent as GetConsumerGroupLagResponse;
        const untouched = payload.topics.find(
          (t) => t.topic === untouchedTopic,
        );
        expect(untouched).toEqual({ topic: untouchedTopic, partitions: [] });
        // The seeded topic's row stays intact.
        const seeded = payload.topics.find((t) => t.topic === topic);
        expect(seeded?.partitions).toHaveLength(1);
        expect(payload.totalLag).toBe(EXPECTED_LAG);
      });

      it("should return the caller-friendly not-found error for an unknown group ID", async () => {
        const result = await server.client.callTool({
          name: ToolName.GET_CONSUMER_GROUP_LAG,
          arguments: { groupId: "int-no-such-group-2147483647" },
        });

        expect(result.isError).toBe(true);
        expect(textContent(result)).toBe(
          'Consumer group "int-no-such-group-2147483647" not found on this cluster.',
        );
      });

      it("should return the caller-friendly not-found error when the topics filter names a nonexistent topic", async () => {
        const nonexistent = uniqueName("nonexistent-topic");
        const result = await server.client.callTool({
          name: ToolName.GET_CONSUMER_GROUP_LAG,
          arguments: { groupId, topics: [nonexistent] },
        });

        expect(result.isError).toBe(true);
        expect(textContent(result)).toBe(
          `Topic "${nonexistent}" not found on this cluster.`,
        );
      });
    });
  },
);
