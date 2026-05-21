import { KafkaJS } from "@confluentinc/kafka-javascript";
import {
  GetPartitionOffsetsHandler,
  type GetPartitionOffsetsResponse,
} from "@src/confluent/tools/handlers/kafka/get-partition-offsets-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  connectTestAdmin,
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

const handler = new GetPartitionOffsetsHandler();
const runtime = integrationRuntime();

const NUM_PARTITIONS = 3;
const SEEDED_VALUES = ["msg-0", "msg-1", "msg-2", "msg-3"];

describe(
  "get-partition-offsets-handler",
  { tags: [Tag.KAFKA, Tag.REQUIRES_KAFKA_CONFIG] },
  () => {
    if (handler.enabledConnectionIds(runtime).length === 0) {
      it.skip("requires kafka.bootstrap_servers config", () => {});
      return;
    }

    let admin: KafkaJS.Admin;
    let producer: KafkaJS.Producer;
    const topic = uniqueName("offsets");

    beforeAll(async () => {
      admin = await connectTestAdmin();
      await admin.createTopics({
        topics: [{ topic, numPartitions: NUM_PARTITIONS }],
      });
      producer = await connectTestProducer();
      // Pin every seed write to partition 0 so the per-partition `messageCount`
      // assertion below can compare against an exact known number rather than
      // a sum across whatever partition the default hash picked.
      await producer.send({
        topic,
        messages: SEEDED_VALUES.map((value) => ({ value, partition: 0 })),
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

      it("should expose get-partition-offsets in tools/list", async () => {
        const { tools } = await server.client.listTools();
        const tool = tools.find(
          (t) => t.name === ToolName.GET_PARTITION_OFFSETS,
        );
        expect(tool).toBeDefined();
      });

      it("should return every partition with messageCount totaling the seeded writes", async () => {
        const result = await server.client.callTool({
          name: ToolName.GET_PARTITION_OFFSETS,
          arguments: { topicName: topic },
        });

        expect(result.isError, textContent(result)).not.toBe(true);
        const payload = result.structuredContent as GetPartitionOffsetsResponse;
        expect(payload.topicName).toBe(topic);
        expect(payload.partitions).toHaveLength(NUM_PARTITIONS);

        const partition0 = payload.partitions.find((p) => p.partition === 0);
        expect(partition0?.messageCount).toBe(SEEDED_VALUES.length);
        expect(partition0?.lowWatermark).toBe("0");
        expect(partition0?.highWatermark).toBe(String(SEEDED_VALUES.length));

        const otherPartitions = payload.partitions.filter(
          (p) => p.partition !== 0,
        );
        for (const p of otherPartitions) {
          expect(p.messageCount).toBe(0);
        }
      });

      it("should restrict the response to one partition when `partition` is supplied", async () => {
        const result = await server.client.callTool({
          name: ToolName.GET_PARTITION_OFFSETS,
          arguments: { topicName: topic, partition: 0 },
        });

        expect(result.isError, textContent(result)).not.toBe(true);
        const payload = result.structuredContent as GetPartitionOffsetsResponse;
        expect(payload.partitions).toHaveLength(1);
        expect(payload.partitions[0]!.partition).toBe(0);
        expect(payload.partitions[0]!.messageCount).toBe(SEEDED_VALUES.length);
      });

      it("should surface a clean out-of-range error citing the actual partition span", async () => {
        const result = await server.client.callTool({
          name: ToolName.GET_PARTITION_OFFSETS,
          arguments: { topicName: topic, partition: 99 },
        });

        expect(result.isError).toBe(true);
        expect(textContent(result)).toContain(
          `Topic "${topic}" has ${NUM_PARTITIONS} partition(s) (0..${NUM_PARTITIONS - 1}); requested partition 99 is out of range`,
        );
      });

      it("should surface a clean 'topic not found' error for an unknown topic without leaking librdkafka text", async () => {
        const result = await server.client.callTool({
          name: ToolName.GET_PARTITION_OFFSETS,
          arguments: { topicName: uniqueName("nonexistent") },
        });

        expect(result.isError).toBe(true);
        expect(textContent(result)).toMatch(
          /Topic ".+" not found on this cluster/,
        );
      });
    });
  },
);
