import { AddTagToTopicHandler } from "@src/confluent/tools/handlers/catalog/add-tags-to-topic.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { getSchemaRegistryClusterId } from "@tests/harness/confluent-cloud.js";
import {
  getTestClusterId,
  withSharedAdminClient,
} from "@tests/harness/kafka-admin.js";
import {
  integrationConnection,
  integrationRuntime,
} from "@tests/harness/runtime.js";
import {
  TEST_AVRO_SCHEMA,
  withSharedCatalogTagsClient,
  withSharedSrClient,
} from "@tests/harness/schema-registry.js";
import { skipIfNotEnabled } from "@tests/harness/skip-gate.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new AddTagToTopicHandler();
const runtime = integrationRuntime();

describe(
  "add-tags-to-topic-handler",
  {
    tags: [
      Tag.CATALOG,
      Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG,
      Tag.REQUIRES_KAFKA_CONFIG,
      Tag.REQUIRES_SCHEMA_REGISTRY_CONFIG,
    ],
  },
  () => {
    if (skipIfNotEnabled(handler, integrationConnection())) {
      return;
    }
    // test-side deps beyond the handler predicate (kafka admin + SR cluster id discovery); gating
    // here keeps a missing field as a skip rather than a beforeAll throw that fails the suite
    const conn = runtime.config.getSoleDirectConnection();
    if (!conn.confluent_cloud) {
      it.skip("requires confluent_cloud config for SR cluster id discovery", () => {});
      return;
    }
    if (
      !conn.kafka?.bootstrap_servers ||
      !conn.kafka.auth ||
      !conn.kafka.cluster_id ||
      !conn.kafka.env_id
    ) {
      it.skip("requires kafka.bootstrap_servers + kafka.auth + kafka.cluster_id + kafka.env_id config", () => {});
      return;
    }

    // installs beforeAll/afterAll at this describe scope: SR REST client + tag cleanup, kafka admin
    // + topic cleanup, SR SDK + subject cleanup (registering a `<topic>-value` subject is what gets
    // the topic indexed in catalog so tag assignment is accepted)
    const { client, createdTags } = withSharedCatalogTagsClient();
    const { admin, createdTopics } = withSharedAdminClient();
    const { client: srClient, createdSubjects } = withSharedSrClient();
    const kafkaClusterId = getTestClusterId();
    let srClusterId: string;

    beforeAll(async () => {
      srClusterId = await getSchemaRegistryClusterId();
    });

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose add-tags-to-topic in tools/list", async () => {
        const { tools } = await server.client.listTools();

        expect(
          tools.find((t) => t.name === ToolName.ADD_TAGS_TO_TOPIC),
        ).toBeDefined();
      });

      it(
        "should assign a tag to a topic",
        // 180s covers the 120s catalog-indexing poll plus topic/schema seed and the assign call
        { timeout: 180_000 },
        async () => {
          // fresh tag + topic per transport so each iteration has clean targets
          const tagName = uniqueName(`addtag-${transport}`);
          const topic = uniqueName(`addtag-${transport}`);
          const subject = `${topic}-value`;
          createdTags.push(tagName);
          createdTopics.push(topic);
          createdSubjects.push(subject);

          const path = wrapAsPathBasedClient(client());
          const { error: tagError } = await path[
            "/catalog/v1/types/tagdefs"
          ].POST({
            body: [
              {
                entityTypes: ["kafka_topic"],
                name: tagName,
                description: "integration test add target",
              },
            ],
          });
          expect(tagError, JSON.stringify(tagError)).toBeUndefined();
          await admin().createTopics({ topics: [{ topic, numPartitions: 1 }] });
          // registering a schema for `<topic>-value` triggers stream governance to index the topic
          // entity in catalog; without it the tag-assign POST 404s on 4040009 ("Instance kafka_topic
          // ... does not exist"). CCloud indexing policy, not a catalog API contract - drop if/when
          // CCloud indexes all topics regardless of schema association
          await srClient().register(subject, { schema: TEST_AVRO_SCHEMA });

          const qualifiedName = `${srClusterId}:${kafkaClusterId}:${topic}`;
          // poll the catalog topic-entity GET until stream governance finishes indexing the new
          // subject->topic association AND echoes the qualified name we constructed; a format drift
          // in CCloud's qualified-name encoding fails fast with a diff here instead of timing out on
          // the assign POST
          await expect
            .poll(
              async () => {
                const { data } = await path[
                  "/catalog/v1/entity/type/{typeName}/name/{qualifiedName}"
                ].GET({
                  params: { path: { typeName: "kafka_topic", qualifiedName } },
                });
                return data?.entity?.attributes?.qualifiedName;
              },
              { timeout: 120_000, interval: 2_000 },
            )
            .toBe(qualifiedName);

          const result = await server.client.callTool({
            name: ToolName.ADD_TAGS_TO_TOPIC,
            arguments: {
              tagAssignments: [
                {
                  entityType: "kafka_topic",
                  entityName: qualifiedName,
                  typeName: tagName,
                },
              ],
            },
          });

          expect(textContent(result)).toMatch(/^Successfully assigned tag:/);
          expect(textContent(result)).toContain(tagName);
        },
      );
    });
  },
);
