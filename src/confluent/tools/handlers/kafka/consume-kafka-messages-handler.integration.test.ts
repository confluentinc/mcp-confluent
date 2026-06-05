import { KafkaJS } from "@confluentinc/kafka-javascript";
import { ConsumeKafkaMessagesHandler } from "@src/confluent/tools/handlers/kafka/consume-kafka-messages-handler.js";
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
import { integrationConnection } from "@tests/harness/runtime.js";
import { skipIfDisabled } from "@tests/harness/skip-gate.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ConsumeKafkaMessagesHandler();

describe(
  "consume-kafka-messages-handler",
  { tags: [Tag.KAFKA, Tag.REQUIRES_KAFKA_CONFIG] },
  () => {
    // the handler's `kafkaBootstrapOrOAuth` predicate accepts either a direct
    // `kafka.bootstrap_servers` block or an OAuth connection; sibling describes exercise each path.
    //
    // The OAuth describe only exercises the basic consume flow — the per-feature variants
    // (partition pinning, offset seeking, timestamp seeking, mixed-direction) live in the direct
    // describe since they exercise consumer-driver behavior that doesn't change between auth modes.

    describe(`with a ${ConnectionType.DIRECT} connection`, () => {
      if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
        it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
        return;
      }
      if (skipIfDisabled(handler, integrationConnection())) {
        return;
      }

      // seed a shared test topic with messages (no need to split by transport)
      let admin: KafkaJS.Admin;
      let producer: KafkaJS.Producer;
      const topic = uniqueName("consume");
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
              topics: [{ name: topic }],
              maxMessages: seededValues.length,
              timeoutMs: 15_000,
              valueFormat: { disableSchemaRegistry: true },
            },
          });

          const text = textContent(result);
          expect(text).toMatch(/^Consumed \d+ messages/);
          for (const value of seededValues) {
            expect(text).toContain(value);
          }
        });

        it("should restrict consumption to one partition when `partition` is set on the topic entry", async () => {
          // Seed a 3-partition topic with three records on the keep
          // partition and one record each on the suppressed partitions,
          // then ask for partition 0 only. `maxMessages: 3` lets the call
          // exit as soon as the three p0 records land instead of waiting
          // out the `timeoutMs` floor, but it also forces the handler to
          // stay alive long enough that a leaked p1/p2 record from a
          // broken pause has a high probability of landing in the
          // response (librdkafka round-robins across partitions, so 3
          // consecutive p0 deliveries before any p1/p2 is unlikely).
          // Asserts: every p0 record appears AND neither suppressed
          // partition's record does — proving the pause step suppressed
          // the non-keep partitions end-to-end against librdkafka, not
          // just against mocks.
          const multiTopic = uniqueName("consume-part");
          await admin.createTopics({
            topics: [{ topic: multiTopic, numPartitions: 3 }],
          });
          try {
            await producer.send({
              topic: multiTopic,
              messages: [
                { partition: 0, value: "p0-msg-a" },
                { partition: 0, value: "p0-msg-b" },
                { partition: 0, value: "p0-msg-c" },
                { partition: 1, value: "p1-msg" },
                { partition: 2, value: "p2-msg" },
              ],
            });

            const result = await server.client.callTool({
              name: ToolName.CONSUME_MESSAGES,
              arguments: {
                topics: [{ name: multiTopic, partition: 0, start: "earliest" }],
                maxMessages: 3,
                timeoutMs: 15_000,
                valueFormat: { disableSchemaRegistry: true },
              },
            });

            const text = textContent(result);
            expect(text).toContain("p0-msg-a");
            expect(text).toContain("p0-msg-b");
            expect(text).toContain("p0-msg-c");
            expect(text).not.toContain("p1-msg");
            expect(text).not.toContain("p2-msg");
          } finally {
            await admin.deleteTopics({ topics: [multiTopic] }).catch(() => {
              // teardown-only; a cleanup failure shouldn't fail an
              // already-asserted test
            });
          }
        });

        it("should seek to an absolute partition offset when `start: {offset}` is set", async () => {
          // Seed a single-partition topic with 5 records; their offsets
          // within the partition are 0..4 (sequential, one batch). Seek
          // to offset 3 and assert: the two later values appear AND the
          // three earlier ones do not. maxMessages = 2 (the count we
          // expect post-seek) so the call returns quickly on success
          // and surfaces a seek failure immediately via the
          // negative-presence assertions on offsets 0..2 if the consumer
          // accidentally landed at the low watermark.
          const offsetTopic = uniqueName("consume-off");
          await admin.createTopics({
            topics: [{ topic: offsetTopic, numPartitions: 1 }],
          });
          try {
            await producer.send({
              topic: offsetTopic,
              messages: [
                { value: "off-0" },
                { value: "off-1" },
                { value: "off-2" },
                { value: "off-3" },
                { value: "off-4" },
              ],
            });

            const result = await server.client.callTool({
              name: ToolName.CONSUME_MESSAGES,
              arguments: {
                topics: [
                  {
                    name: offsetTopic,
                    partition: 0,
                    start: { offset: "3" },
                  },
                ],
                maxMessages: 2,
                timeoutMs: 15_000,
                valueFormat: { disableSchemaRegistry: true },
              },
            });

            const text = textContent(result);
            // Pin to the JSON `"value": "..."` shape rather than bare
            // substring matching — `uniqueName("consume-off")` produces a
            // topic name like `int-consume-off-1779...` which contains the
            // substring `off-1`, so a loose `toContain("off-1")` would
            // false-positive against the topic name in the response prose.
            expect(text).toContain('"value": "off-3"');
            expect(text).toContain('"value": "off-4"');
            expect(text).not.toContain('"value": "off-0"');
            expect(text).not.toContain('"value": "off-1"');
            expect(text).not.toContain('"value": "off-2"');
          } finally {
            await admin.deleteTopics({ topics: [offsetTopic] }).catch(() => {
              // teardown-only; a cleanup failure shouldn't fail an
              // already-asserted test
            });
          }
        });

        it("should seek to the broker-resolved offset for a midpoint timestamp, returning only records produced past it", async () => {
          // Produce batch A, sleep, produce batch B. The wall-clock gap
          // between the two batches gives us a midpoint timestamp that
          // sits after every A record's broker-assigned timestamp and
          // before every B record's, so the broker's timestamp index
          // should resolve our seek target to the first B offset.
          // Exercises the live `admin.fetchTopicOffsetsByTimestamp` path
          // and the silent-substitution defense — neither is reachable
          // through the unit-test mocks.
          const tsTopic = uniqueName("consume-ts");
          await admin.createTopics({
            topics: [{ topic: tsTopic, numPartitions: 1 }],
          });
          try {
            await producer.send({
              topic: tsTopic,
              messages: [{ value: "a-0" }, { value: "a-1" }, { value: "a-2" }],
            });
            const afterA = Date.now();

            // ~2s gap — long enough that round-trip timestamp jitter
            // (producer assigns at send time; broker may add a few ms) can't
            // muddle the midpoint window.
            await new Promise<void>((r) => setTimeout(r, 2000));

            const beforeB = Date.now();
            await producer.send({
              topic: tsTopic,
              messages: [{ value: "b-0" }, { value: "b-1" }, { value: "b-2" }],
            });

            const midpointMs = Math.floor((afterA + beforeB) / 2);

            const result = await server.client.callTool({
              name: ToolName.CONSUME_MESSAGES,
              arguments: {
                topics: [{ name: tsTopic, start: { timestamp: midpointMs } }],
                maxMessages: 3,
                timeoutMs: 15_000,
                valueFormat: { disableSchemaRegistry: true },
              },
            });

            const text = textContent(result);
            // Only batch B should be present; the seek must have skipped
            // past every A record.
            expect(text).toContain('"value": "b-0"');
            expect(text).toContain('"value": "b-1"');
            expect(text).toContain('"value": "b-2"');
            expect(text).not.toContain('"value": "a-0"');
            expect(text).not.toContain('"value": "a-1"');
            expect(text).not.toContain('"value": "a-2"');
          } finally {
            await admin.deleteTopics({ topics: [tsTopic] }).catch(() => {
              // teardown-only; a cleanup failure shouldn't fail an
              // already-asserted test
            });
          }
        });

        it("should honor a mixed-direction call: replay history on a topic asking for `start: 'earliest'` while parking at the high watermark on a peer topic asking for `start: 'latest'`", async () => {
          // Two topics, both seeded with history before the consume call.
          // Topic A asks for "earliest" → the orchestrator's mixed-direction
          // path issues an explicit low-watermark seek for A while leaving
          // the consumer-wide `auto.offset.reset` at "latest" for B.
          // Result: A's history replays, B contributes nothing because
          // nothing is produced to it during the consume window.
          const topicA = uniqueName("consume-mix-a");
          const topicB = uniqueName("consume-mix-b");
          await admin.createTopics({
            topics: [
              { topic: topicA, numPartitions: 1 },
              { topic: topicB, numPartitions: 1 },
            ],
          });
          try {
            await producer.send({
              topic: topicA,
              messages: [
                { value: "alpha-0" },
                { value: "alpha-1" },
                { value: "alpha-2" },
              ],
            });
            await producer.send({
              topic: topicB,
              messages: [
                { value: "beta-0" },
                { value: "beta-1" },
                { value: "beta-2" },
              ],
            });

            const result = await server.client.callTool({
              name: ToolName.CONSUME_MESSAGES,
              arguments: {
                topics: [
                  { name: topicA, start: "earliest" },
                  { name: topicB, start: "latest" },
                ],
                // Exactly the count of A's seeded history. On success the
                // call resolves as soon as those 3 land; B's "latest"
                // arm contributes nothing because no producer is writing
                // to it during the window.
                maxMessages: 3,
                timeoutMs: 15_000,
                valueFormat: { disableSchemaRegistry: true },
              },
            });

            const text = textContent(result);
            // Topic A's history must replay end-to-end.
            expect(text).toContain('"value": "alpha-0"');
            expect(text).toContain('"value": "alpha-1"');
            expect(text).toContain('"value": "alpha-2"');
            // Topic B's history must NOT appear — `start: "latest"` parks
            // the consumer at B's high watermark, and nothing is produced
            // post-call.
            expect(text).not.toContain('"value": "beta-0"');
            expect(text).not.toContain('"value": "beta-1"');
            expect(text).not.toContain('"value": "beta-2"');
          } finally {
            await admin.deleteTopics({ topics: [topicA, topicB] }).catch(() => {
              // teardown-only; a cleanup failure shouldn't fail an
              // already-asserted test
            });
          }
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
        if (
          skipIfDisabled(
            handler,
            integrationConnection({ oauth: true }),
            OAUTH_FIXTURE_NOT_LOADED_REASON,
          )
        ) {
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
        if (
          skipIfDisabled(
            handler,
            integrationConnection(),
            DIRECT_FIXTURE_REQUIRED_FOR_OAUTH_SEEDING_REASON,
          )
        ) {
          return;
        }

        // OAuth connections carry no `kafka` block, so the handler resolves the broker from
        // `cluster_id` + `environment_id` at call time; under OAuth the handler errors when omitted
        const clusterId = getTestClusterId();
        const environmentId = getTestEnvironmentId();

        // seed via the api-key-authed admin + producer; the CONSUME_MESSAGES call goes via OAuth
        let admin: KafkaJS.Admin;
        let producer: KafkaJS.Producer;
        const topic = uniqueName("consume-oauth");
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
            server = await startOAuthServer({ transport });
          }, 180_000);

          afterAll(async () => {
            await stopOAuthServer(server);
          });

          // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
          it("should consume the seeded messages from the topic", async () => {
            const result = await callToolWithOAuthFlow(server, credentials, {
              name: ToolName.CONSUME_MESSAGES,
              arguments: {
                topics: [{ name: topic, start: "earliest" }],
                maxMessages: seededValues.length,
                timeoutMs: 15_000,
                valueFormat: { disableSchemaRegistry: true },
                cluster_id: clusterId,
                environment_id: environmentId,
              },
            });

            const text = textContent(result);
            expect(text).toMatch(/^Consumed \d+ messages/);
            for (const value of seededValues) {
              expect(text).toContain(value);
            }
          });
        });
      },
    );
  },
);
