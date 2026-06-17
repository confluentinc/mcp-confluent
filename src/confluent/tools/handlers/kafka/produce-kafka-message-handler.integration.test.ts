import { KafkaJS } from "@confluentinc/kafka-javascript";
import { VALUE_SCHEMA_ID_HEADER } from "@confluentinc/schemaregistry";
import { ProduceKafkaMessageHandler } from "@src/confluent/tools/handlers/kafka/produce-kafka-message-handler.js";
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
import { withSharedSrClient } from "@tests/harness/schema-registry.js";
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

const handler = new ProduceKafkaMessageHandler();

describe(
  "produce-kafka-message-handler",
  { tags: [Tag.KAFKA, Tag.REQUIRES_KAFKA_CONFIG] },
  () => {
    // the handler's `kafkaBootstrapOrOAuth` predicate accepts either a direct
    // `kafka.bootstrap_servers` block or an OAuth connection; sibling describes exercise each path

    describe(`with a ${ConnectionType.DIRECT} connection`, () => {
      if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
        it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
        return;
      }
      if (skipIfDisabled(handler, integrationConnection())) {
        return;
      }

      // single shared topic for all transports (cheaper than creating one per transport)
      let admin: KafkaJS.Admin;
      const topic = uniqueName("produce");

      beforeAll(async () => {
        admin = await connectTestAdmin();
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
          server = await startServer({ transport });
        });

        afterAll(async () => {
          await server?.stop();
        });

        it("should produce a raw-string message and return a partition+offset delivery report", async () => {
          const result = await server.client.callTool({
            name: ToolName.PRODUCE_MESSAGE,
            arguments: {
              topicName: topic,
              value: { message: `hello from ${transport}` },
            },
          });

          // handler formats each delivery report as:
          //   "Message produced successfully to [Topic: ..., Partition: ..., Offset: ...]"
          const text = textContent(result);
          expect(text).toMatch(/Message produced successfully to \[Topic: /);
          expect(text).toContain(topic);
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
        // `connectTestAdmin()` builds an api-key kafka client from the direct fixture; gate the
        // OAuth describe on the same predicate the direct describe uses so an OAuth-only CI lane
        // without direct creds skips cleanly instead of crashing in beforeAll
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

        // seed via the api-key-authed admin client; the PRODUCE_MESSAGE call goes via OAuth
        let admin: KafkaJS.Admin;
        const topic = uniqueName("produce-oauth");

        beforeAll(async () => {
          admin = await connectTestAdmin();
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
            server = await startOAuthServer({ transport });
          }, 180_000);

          afterAll(async () => {
            await stopOAuthServer(server);
          });

          // first auth-required call starts the CCloud OAuth flow; cached tokens reuse for later tests
          it("should produce a raw-string message and return a partition+offset delivery report", async () => {
            const result = await callToolWithOAuthFlow(server, credentials, {
              name: ToolName.PRODUCE_MESSAGE,
              arguments: {
                topicName: topic,
                value: { message: `hello from oauth ${transport}` },
                cluster_id: clusterId,
                environment_id: environmentId,
              },
            });

            const text = textContent(result);
            expect(text).toMatch(/Message produced successfully to \[Topic: /);
            expect(text).toContain(topic);
          });
        });
      },
    );

    describe(
      "with a top-level Avro primitive value schema",
      { tags: [Tag.REQUIRES_SCHEMA_REGISTRY_CONFIG] },
      () => {
        if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
          it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
          return;
        }
        // kafka gate (handler predicate), then a schema-registry gate so a
        // fixture carrying kafka but no schema_registry block skips cleanly
        // rather than failing when the produce call reaches for an SR client.
        if (skipIfDisabled(handler, integrationConnection())) {
          return;
        }
        const connection = integrationConnection();
        if (connection.type !== "direct" || !connection.schema_registry) {
          it.skip("requires schema_registry config", () => {});
          return;
        }

        let admin: KafkaJS.Admin;
        const topic = uniqueName("produce-avro-long");
        // shared SR client only for subject cleanup; the produce call itself
        // registers the schema via its `schema` argument
        const { createdSubjects } = withSharedSrClient();

        beforeAll(async () => {
          admin = await connectTestAdmin();
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
            server = await startServer({ transport });
          });

          afterAll(async () => {
            await server?.stop();
          });

          it("should serialize and produce a numeric long value against a primitive schema", async () => {
            createdSubjects.push(`${topic}-value`);
            const result = await server.client.callTool({
              name: ToolName.PRODUCE_MESSAGE,
              arguments: {
                topicName: topic,
                value: {
                  message: 123,
                  useSchemaRegistry: true,
                  schemaType: "AVRO",
                  schema: '"long"',
                },
              },
            });

            const text = textContent(result);
            expect(text).toMatch(/Message produced successfully to \[Topic: /);
            expect(text).toContain(topic);
          });
        });
      },
    );

    describe("with record metadata (partition, timestamp, headers)", () => {
      if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
        it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
        return;
      }
      if (skipIfDisabled(handler, integrationConnection())) {
        return;
      }

      const NUM_PARTITIONS = 3;
      const TARGET_PARTITION = 1;
      let admin: KafkaJS.Admin;
      const topic = uniqueName("produce-metadata");

      beforeAll(async () => {
        admin = await connectTestAdmin();
        await admin.createTopics({
          topics: [{ topic, numPartitions: NUM_PARTITIONS }],
        });
      });

      afterAll(async () => {
        await admin.deleteTopics({ topics: [topic] }).catch(() => {
          // teardown-only; a cleanup failure shouldn't fail an already-asserted test
        });
        await admin.disconnect();
      });

      describe.each(activeTransports)("via %s transport", (transport) => {
        let server: StartedServer;
        let consumer: KafkaJS.Consumer | undefined;

        beforeAll(async () => {
          server = await startServer({ transport });
        });

        afterAll(async () => {
          await consumer?.disconnect().catch(() => {
            // disconnect race during teardown isn't actionable
          });
          await server?.stop();
        });

        it("should round-trip an explicit partition, timestamp, and headers through the broker", async () => {
          const isoTimestamp = "2026-05-14T17:00:00Z";
          const expectedMs = String(Date.parse(isoTimestamp));
          // unique per transport: the topic is shared across the describe.each
          // iterations, so the read-back must single out this case's own record
          const expectedValue = `metadata via ${transport}`;

          const produceResult = await server.client.callTool({
            name: ToolName.PRODUCE_MESSAGE,
            arguments: {
              topicName: topic,
              value: { message: expectedValue },
              partition: TARGET_PARTITION,
              timestamp: isoTimestamp,
              headers: { source: "clusterA", trace: ["x", "y"] },
            },
          });

          const produceText = textContent(produceResult);
          expect(produceText).toMatch(
            /Message produced successfully to \[Topic: /,
          );
          // the explicit partition target reached the broker, per the delivery report
          expect(produceText).toContain(`Partition: ${TARGET_PARTITION}`);

          // read the record back from the start of the topic to prove all three
          // metadata fields survived the broker round-trip
          consumer = await connectTestConsumer(
            uniqueName(`md-reader-${transport}`),
            { fromBeginning: true },
          );
          await consumer.subscribe({ topics: [topic] });
          const record = await new Promise<KafkaJS.EachMessagePayload>(
            (resolve, reject) => {
              const timer = setTimeout(
                () =>
                  reject(new Error("timed out waiting for produced record")),
                20_000,
              );
              consumer!
                .run({
                  eachMessage: async (payload) => {
                    // skip any sibling transport's record on the shared topic; only
                    // this case's record proves its own metadata round-tripped
                    if (payload.message.value?.toString() !== expectedValue) {
                      return;
                    }
                    clearTimeout(timer);
                    resolve(payload);
                  },
                })
                // a run() rejection (rebalance, network) would otherwise surface
                // as an unhandled rejection and flake the suite; fail this case
                // deterministically instead
                .catch((err) => {
                  clearTimeout(timer);
                  reject(err);
                });
            },
          );

          expect(record.message.value?.toString()).toBe(expectedValue);

          expect(record.partition).toBe(TARGET_PARTITION);
          expect(record.message.timestamp).toBe(expectedMs);
          expect(record.message.headers?.source?.toString()).toBe("clusterA");
          const trace = record.message.headers?.trace;
          const traceValues = Array.isArray(trace) ? trace : [trace];
          expect(traceValues.map((v) => v?.toString())).toEqual(["x", "y"]);
        });
      });
    });

    describe(
      "with a header-located schema id (schemaIdLocation: header)",
      { tags: [Tag.REQUIRES_SCHEMA_REGISTRY_CONFIG] },
      () => {
        if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
          it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
          return;
        }
        if (skipIfDisabled(handler, integrationConnection())) {
          return;
        }
        const connection = integrationConnection();
        if (connection.type !== "direct" || !connection.schema_registry) {
          it.skip("requires schema_registry config", () => {});
          return;
        }

        let admin: KafkaJS.Admin;
        const topic = uniqueName("produce-sr-header");
        const { createdSubjects } = withSharedSrClient();
        const valueSchema =
          '{"type":"record","name":"R","fields":[{"name":"x","type":"string"}]}';

        beforeAll(async () => {
          admin = await connectTestAdmin();
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
          let consumer: KafkaJS.Consumer | undefined;

          beforeAll(async () => {
            server = await startServer({ transport });
          });

          afterAll(async () => {
            await consumer?.disconnect().catch(() => {
              // disconnect race during teardown isn't actionable
            });
            await server?.stop();
          });

          it("should write the schema id to the record header, leave the payload prefix-free, and decode it back through consume-messages", async () => {
            createdSubjects.push(`${topic}-value`);
            // unique per transport: the topic is shared across the describe.each
            // iterations, so each read-back must single out its own record
            const marker = `hdr-${transport}`;

            const produceResult = await server.client.callTool({
              name: ToolName.PRODUCE_MESSAGE,
              arguments: {
                topicName: topic,
                value: {
                  message: { x: marker },
                  useSchemaRegistry: true,
                  schemaType: "AVRO",
                  schema: valueSchema,
                  schemaIdLocation: "header",
                },
              },
            });
            const produceText = textContent(produceResult);
            expect(produceText).toMatch(
              /Message produced successfully to \[Topic: /,
            );

            // raw read-back proves the wire format: the schema id rides in the
            // __value_schema_id header and the payload carries no magic-byte
            // prefix (a prefixed record would start with 0x00)
            consumer = await connectTestConsumer(
              uniqueName(`hdr-reader-${transport}`),
              { fromBeginning: true },
            );
            await consumer.subscribe({ topics: [topic] });
            const record = await new Promise<KafkaJS.EachMessagePayload>(
              (resolve, reject) => {
                const timer = setTimeout(
                  () =>
                    reject(new Error("timed out waiting for produced record")),
                  20_000,
                );
                consumer!
                  .run({
                    eachMessage: async (payload) => {
                      const idHeader =
                        payload.message.headers?.[VALUE_SCHEMA_ID_HEADER];
                      // skip sibling transports' records: only ours carries a
                      // header-located id whose decode yields this marker. Records
                      // without the header (or a non-matching one) aren't ours.
                      if (!idHeader) {
                        return;
                      }
                      clearTimeout(timer);
                      resolve(payload);
                    },
                  })
                  .catch((err) => {
                    clearTimeout(timer);
                    reject(err);
                  });
              },
            );

            const idHeader = record.message.headers?.[VALUE_SCHEMA_ID_HEADER];
            expect(Buffer.isBuffer(idHeader)).toBe(true);
            // bare Avro payload — no leading magic byte 0
            expect(record.message.value?.[0]).not.toBe(0);

            // and the consume-messages tool decodes the header-located id back
            // into the structured value (proves the consume side reads the header)
            const consumeResult = await server.client.callTool({
              name: ToolName.CONSUME_MESSAGES,
              arguments: {
                topics: [{ name: topic, start: "earliest" }],
                maxMessages: 10,
                timeoutMs: 15_000,
              },
            });
            expect(textContent(consumeResult)).toContain(marker);

            // bypassing deserialization surfaces the raw record, schema-id header
            // included — the manual path for verifying the on-the-wire encoding
            const rawConsumeResult = await server.client.callTool({
              name: ToolName.CONSUME_MESSAGES,
              arguments: {
                topics: [{ name: topic, start: "earliest" }],
                maxMessages: 10,
                timeoutMs: 15_000,
                valueFormat: { disableSchemaRegistry: true },
              },
            });
            expect(textContent(rawConsumeResult)).toContain(
              VALUE_SCHEMA_ID_HEADER,
            );
          });
        });
      },
    );
  },
);
