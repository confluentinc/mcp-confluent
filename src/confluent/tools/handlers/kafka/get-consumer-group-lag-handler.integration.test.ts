import { KafkaJS } from "@confluentinc/kafka-javascript";
import {
  GetConsumerGroupLagHandler,
  type GetConsumerGroupLagResponse,
} from "@src/confluent/tools/handlers/kafka/get-consumer-group-lag-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { getTestEnvironmentId } from "@tests/harness/confluent-cloud.js";
import {
  activeConnectionTypes,
  CONNECTION_TYPE_DIRECT_FILTERED_REASON,
  CONNECTION_TYPE_OAUTH_FILTERED_REASON,
  ConnectionType,
} from "@tests/harness/connection-types.js";
import {
  connectTestAdmin,
  connectTestConsumer,
  connectTestProducer,
  getTestClusterId,
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

const handler = new GetConsumerGroupLagHandler();

const NUM_PARTITIONS = 3;
const SEEDED_MESSAGE_COUNT = 10;
const COMMITTED_OFFSET = 4;
const EXPECTED_LAG = SEEDED_MESSAGE_COUNT - COMMITTED_OFFSET;

describe("get-consumer-group-lag-handler", { tags: [Tag.KAFKA] }, () => {
  // the handler's `kafkaBootstrapOrOAuth` predicate accepts either a direct
  // `kafka.bootstrap_servers` block or an OAuth connection; sibling describes exercise each path.
  //
  // The OAuth describe only runs the deterministic-lag happy-path call — the topics-filter,
  // never-committed-topic, and not-found error-surface tests live in the direct describe since
  // they exercise handler logic that doesn't change between auth modes.

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
      // `connectTestAdmin/Producer/Consumer` build api-key kafka clients from the direct
      // fixture; gate the OAuth describe on the same predicate the direct describe uses so an
      // OAuth-only CI lane without direct creds skips cleanly instead of crashing in beforeAll
      const directRuntime = integrationRuntime({ oauth: false });
      if (handler.enabledConnectionIds(directRuntime).length === 0) {
        it.skip(DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON, () => {});
        return;
      }

      // OAuth handlers don't carry a `kafka` block, so the broker is resolved at call time from
      // `cluster_id` + `environment_id`; under OAuth the handler errors when omitted
      const clusterId = getTestClusterId();
      const environmentId = getTestEnvironmentId();

      // seed via the api-key-authed admin + producer + consumer; the GET_CONSUMER_GROUP_LAG call
      // goes via OAuth
      let admin: KafkaJS.Admin;
      let producer: KafkaJS.Producer;
      const topic = uniqueName("lag-oauth");
      const groupId = uniqueName("lag-group-oauth");

      beforeAll(async () => {
        admin = await connectTestAdmin();
        await admin.createTopics({
          topics: [{ topic, numPartitions: NUM_PARTITIONS }],
        });
        producer = await connectTestProducer();
        await producer.send({
          topic,
          messages: Array.from({ length: SEEDED_MESSAGE_COUNT }, (_, i) => ({
            value: `msg-${i}`,
            partition: 0,
          })),
        });

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
        await admin.deleteGroups([groupId]).catch(() => {
          // teardown-only; a cleanup failure shouldn't fail an already-asserted test
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
        it("should return the deterministic lag for the seeded group on the seeded topic", async () => {
          const result = await callToolWithOAuthFlow(server, credentials, {
            name: ToolName.GET_CONSUMER_GROUP_LAG,
            arguments: {
              groupId,
              cluster_id: clusterId,
              environment_id: environmentId,
            },
          });

          expect(result.isError, textContent(result)).not.toBe(true);
          const payload =
            result.structuredContent as GetConsumerGroupLagResponse;
          expect(payload.groupId).toBe(groupId);
          expect(payload.totalLag).toBe(EXPECTED_LAG);
        });
      });
    },
  );
});
