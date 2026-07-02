import { KafkaJS } from "@confluentinc/kafka-javascript";
import { SearchMessagesHandler } from "@src/confluent/tools/handlers/kafka/search-messages-handler.js";
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

const handler = new SearchMessagesHandler();

describe(
  "search-messages-handler",
  { tags: [Tag.KAFKA, Tag.REQUIRES_KAFKA_CONFIG] },
  () => {
    // the handler's `kafkaBootstrapOrOAuth` predicate accepts either a direct
    // `kafka.bootstrap_servers` block or an OAuth connection; sibling describes exercise each path.
    //
    // The OAuth describe only exercises the basic substring search — the per-feature variants
    // (regex, searchIn key/headers, maxMatches/maxScanned bounds) live in the direct describe
    // since they exercise the matcher/bounded-scan behavior that doesn't change between auth modes.

    describe(`with a ${ConnectionType.DIRECT} connection`, () => {
      if (!activeConnectionTypes.includes(ConnectionType.DIRECT)) {
        it.skip(CONNECTION_TYPE_DIRECT_FILTERED_REASON, () => {});
        return;
      }
      if (skipIfDisabled(handler, integrationConnection())) {
        return;
      }

      // Seed a shared single-partition topic. Single partition keeps delivery
      // in offset order, so `maxScanned`/`maxMatches` exit conditions are
      // deterministic across runs (librdkafka round-robins across partitions,
      // which would make per-message ordering non-deterministic).
      let admin: KafkaJS.Admin;
      let producer: KafkaJS.Producer;
      const topic = uniqueName("search");
      // Two of the three values contain "needle"; the matcher must pick out
      // exactly those two and leave "beta plain" behind.
      const seededValues = ["alpha needle", "beta plain", "gamma needle"];

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

        it("should return only the value-matching messages and a Found/scanned summary", async () => {
          // `maxScanned === seededValues.length` lets the call exit as soon as
          // the three seeded records are scanned instead of waiting out the
          // `timeoutMs` floor on a finite topic.
          const result = await server.client.callTool({
            name: ToolName.SEARCH_MESSAGES,
            arguments: {
              topicNames: [topic],
              query: "needle",
              maxScanned: seededValues.length,
              timeoutMs: 15_000,
              valueFormat: { disableSchemaRegistry: true },
              keyFormat: { disableSchemaRegistry: true },
            },
          });

          const text = textContent(result);
          expect(text).toContain(
            `Found 2 matches in 3 scanned messages from topics ${topic}.`,
          );
          // Pin to the JSON `"value": "..."` shape so the assertions read the
          // serialized matches, not the summary prose.
          expect(text).toContain('"value": "alpha needle"');
          expect(text).toContain('"value": "gamma needle"');
          expect(text).not.toContain('"value": "beta plain"');
        });

        it("should match the value with a regex query", async () => {
          const result = await server.client.callTool({
            name: ToolName.SEARCH_MESSAGES,
            arguments: {
              topicNames: [topic],
              query: "gamma.*needle",
              queryMode: "regex",
              maxScanned: seededValues.length,
              timeoutMs: 15_000,
              valueFormat: { disableSchemaRegistry: true },
              keyFormat: { disableSchemaRegistry: true },
            },
          });

          const text = textContent(result);
          expect(text).toContain(
            `Found 1 matches in 3 scanned messages from topics ${topic}.`,
          );
          expect(text).toContain('"value": "gamma needle"');
          // The regex anchors on "gamma", so the other "needle" record is not
          // a match.
          expect(text).not.toContain('"value": "alpha needle"');
        });

        it("should stop once maxMatches matches are found", async () => {
          // maxMatches: 1 fires on the first (offset-0) record, so the call
          // returns after scanning exactly one message and the later "gamma
          // needle" match is never reached.
          const result = await server.client.callTool({
            name: ToolName.SEARCH_MESSAGES,
            arguments: {
              topicNames: [topic],
              query: "needle",
              maxMatches: 1,
              timeoutMs: 15_000,
              valueFormat: { disableSchemaRegistry: true },
              keyFormat: { disableSchemaRegistry: true },
            },
          });

          const text = textContent(result);
          expect(text).toContain(
            `Found 1 matches in 1 scanned messages from topics ${topic}.`,
          );
          expect(text).toContain('"value": "alpha needle"');
          expect(text).not.toContain('"value": "gamma needle"');
        });

        it("should report zero matches but still count scanned messages", async () => {
          const result = await server.client.callTool({
            name: ToolName.SEARCH_MESSAGES,
            arguments: {
              topicNames: [topic],
              query: "no-such-term",
              maxScanned: seededValues.length,
              timeoutMs: 15_000,
              valueFormat: { disableSchemaRegistry: true },
              keyFormat: { disableSchemaRegistry: true },
            },
          });

          const text = textContent(result);
          expect(text).toContain(
            `Found 0 matches in 3 scanned messages from topics ${topic}.`,
          );
        });

        it("should restrict matching to the key when `searchIn: ['key']` is set", async () => {
          // Seed a topic whose match-worthy text lives only in the KEY; the
          // values deliberately carry no searchable term, so a hit proves the
          // matcher read the decoded key rather than falling back to the value.
          const keyTopic = uniqueName("search-key");
          await admin.createTopics({
            topics: [{ topic: keyTopic, numPartitions: 1 }],
          });
          try {
            await producer.send({
              topic: keyTopic,
              messages: [
                { key: "user-1", value: "v-a" },
                { key: "order-9", value: "v-b" },
              ],
            });

            const result = await server.client.callTool({
              name: ToolName.SEARCH_MESSAGES,
              arguments: {
                topicNames: [keyTopic],
                query: "user",
                searchIn: ["key"],
                maxScanned: 2,
                timeoutMs: 15_000,
                valueFormat: { disableSchemaRegistry: true },
                keyFormat: { disableSchemaRegistry: true },
              },
            });

            const text = textContent(result);
            expect(text).toContain(
              `Found 1 matches in 2 scanned messages from topics ${keyTopic}.`,
            );
            expect(text).toContain('"key": "user-1"');
            expect(text).not.toContain('"key": "order-9"');
          } finally {
            await admin.deleteTopics({ topics: [keyTopic] }).catch(() => {
              // teardown-only; a cleanup failure shouldn't fail an
              // already-asserted test
            });
          }
        });

        it("should match against header names and values when `searchIn: ['headers']` is set", async () => {
          // The match term lives only in a record header, not the key or
          // value, so a hit proves the matcher walked the echoed headers.
          const headerTopic = uniqueName("search-hdr");
          await admin.createTopics({
            topics: [{ topic: headerTopic, numPartitions: 1 }],
          });
          try {
            await producer.send({
              topic: headerTopic,
              messages: [
                {
                  value: "plain-body",
                  headers: { trace: "needle-header" },
                },
              ],
            });

            const result = await server.client.callTool({
              name: ToolName.SEARCH_MESSAGES,
              arguments: {
                topicNames: [headerTopic],
                query: "needle-header",
                searchIn: ["headers"],
                maxScanned: 1,
                timeoutMs: 15_000,
                valueFormat: { disableSchemaRegistry: true },
                keyFormat: { disableSchemaRegistry: true },
              },
            });

            const text = textContent(result);
            expect(text).toContain(
              `Found 1 matches in 1 scanned messages from topics ${headerTopic}.`,
            );
            expect(text).toContain("needle-header");
          } finally {
            await admin.deleteTopics({ topics: [headerTopic] }).catch(() => {
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

        // seed via the api-key-authed admin + producer; the SEARCH_MESSAGES call goes via OAuth
        let admin: KafkaJS.Admin;
        let producer: KafkaJS.Producer;
        const topic = uniqueName("search-oauth");
        const seededValues = ["alpha needle", "beta plain", "gamma needle"];

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
          it("should return only the value-matching messages and a Found/scanned summary", async () => {
            const result = await callToolWithOAuthFlow(server, credentials, {
              name: ToolName.SEARCH_MESSAGES,
              arguments: {
                topicNames: [topic],
                query: "needle",
                maxScanned: seededValues.length,
                timeoutMs: 15_000,
                valueFormat: { disableSchemaRegistry: true },
                keyFormat: { disableSchemaRegistry: true },
                cluster_id: clusterId,
                environment_id: environmentId,
              },
            });

            const text = textContent(result);
            expect(text).toContain(
              `Found 2 matches in 3 scanned messages from topics ${topic}.`,
            );
            expect(text).toContain('"value": "alpha needle"');
            expect(text).toContain('"value": "gamma needle"');
            expect(text).not.toContain('"value": "beta plain"');
          });
        });
      },
    );
  },
);
