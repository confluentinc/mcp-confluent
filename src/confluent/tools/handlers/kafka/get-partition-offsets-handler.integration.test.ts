import { KafkaJS } from "@confluentinc/kafka-javascript";
import {
  GetPartitionOffsetsHandler,
  type GetPartitionOffsetsResponse,
} from "@src/confluent/tools/handlers/kafka/get-partition-offsets-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  activeConnectionTypes,
  CONNECTION_TYPE_DIRECT_FILTERED_REASON,
  CONNECTION_TYPE_OAUTH_FILTERED_REASON,
  ConnectionType,
} from "@tests/harness/connection-types.js";
import {
  connectTestAdmin,
  connectTestProducer,
} from "@tests/harness/kafka-admin.js";
import {
  callToolWithOAuthFlow,
  DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON,
  getOAuthCredentialsFromEnv,
  OAUTH_FIXTURE_NOT_LOADED_REASON,
  OAUTH_USER_CREDS_MISSING_REASON,
  startOAuthServer,
  stopOAuthServer,
} from "@tests/harness/oauth-flow.js";
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

const NUM_PARTITIONS = 3;
const SEEDED_VALUES = ["msg-0", "msg-1", "msg-2", "msg-3"];

describe("get-partition-offsets-handler", { tags: [Tag.KAFKA] }, () => {
  // the handler's `kafkaBootstrapOrOAuth` predicate accepts either a direct
  // `kafka.bootstrap_servers` block or an OAuth connection; sibling describes exercise each path.
  //
  // The OAuth describe only exercises the basic-coverage tool call — the partition-pinning and
  // error-surface tests live in the direct describe since they exercise handler logic that
  // doesn't change between auth modes.

  describe(`with a ${ConnectionType.DIRECT} connection`, () => {
    if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
      it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
      return;
    }
    const directRuntime = integrationRuntime({ oauth: false });
    if (handler.enabledConnectionIds(directRuntime).length === 0) {
      it.skip("requires kafka.bootstrap_servers in test-fixtures/yaml_configs/integration.yaml", () => {});
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
  });

  describe(
    `with a ${ConnectionType.OAUTH} connection`,
    { tags: [Tag.OAUTH] },
    () => {
      if (!activeConnectionTypes.includes(ConnectionType.OAUTH)) {
        it.skip(CONNECTION_TYPE_OAUTH_FILTERED_REASON, () => {});
        return;
      }
      const oauthRuntime = integrationRuntime({ oauth: true });
      if (handler.enabledConnectionIds(oauthRuntime).length === 0) {
        it.skip(OAUTH_FIXTURE_NOT_LOADED_REASON, () => {});
        return;
      }
      const credentials = getOAuthCredentialsFromEnv();
      if (!credentials) {
        it.skip(OAUTH_USER_CREDS_MISSING_REASON, () => {});
        return;
      }
      // `connectTestAdmin()`/`connectTestProducer()` build api-key kafka clients from the direct
      // fixture; gate the OAuth describe on the same predicate the direct describe uses so an
      // OAuth-only CI lane without direct creds skips cleanly instead of crashing in beforeAll
      const directRuntime = integrationRuntime({ oauth: false });
      if (handler.enabledConnectionIds(directRuntime).length === 0) {
        it.skip(DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON, () => {});
        return;
      }

      // seed via the api-key-authed admin + producer; the GET_PARTITION_OFFSETS call goes via OAuth
      let admin: KafkaJS.Admin;
      let producer: KafkaJS.Producer;
      const topic = uniqueName("offsets-oauth");

      beforeAll(async () => {
        admin = await connectTestAdmin();
        await admin.createTopics({
          topics: [{ topic, numPartitions: NUM_PARTITIONS }],
        });
        producer = await connectTestProducer();
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
          server = await startOAuthServer({ transport });
        }, 180_000);

        afterAll(async () => {
          await stopOAuthServer(server);
        });

        // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
        it("should return every partition with messageCount totaling the seeded writes", async () => {
          const result = await callToolWithOAuthFlow(server, credentials, {
            name: ToolName.GET_PARTITION_OFFSETS,
            arguments: { topicName: topic },
          });

          expect(result.isError, textContent(result)).not.toBe(true);
          const payload =
            result.structuredContent as GetPartitionOffsetsResponse;
          expect(payload.topicName).toBe(topic);
          expect(payload.partitions).toHaveLength(NUM_PARTITIONS);

          const partition0 = payload.partitions.find((p) => p.partition === 0);
          expect(partition0?.messageCount).toBe(SEEDED_VALUES.length);
        });
      });
    },
  );
});
