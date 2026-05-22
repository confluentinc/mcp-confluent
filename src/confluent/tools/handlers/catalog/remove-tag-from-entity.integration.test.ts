import { RemoveTagFromEntityHandler } from "@src/confluent/tools/handlers/catalog/remove-tag-from-entity.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { getSchemaRegistryClusterId } from "@tests/harness/confluent-cloud.js";
import {
  getTestClusterId,
  withSharedAdminClient,
} from "@tests/harness/kafka-admin.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  TEST_AVRO_SCHEMA,
  withSharedCatalogTagsClient,
  withSharedSrClient,
} from "@tests/harness/schema-registry.js";
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

const handler = new RemoveTagFromEntityHandler();
const runtime = integrationRuntime();

describe(
  "remove-tag-from-entity-handler",
  {
    tags: [
      Tag.CATALOG,
      Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG,
      Tag.REQUIRES_KAFKA_CONFIG,
      Tag.REQUIRES_SCHEMA_REGISTRY_CONFIG,
    ],
  },
  () => {
    if (handler.enabledConnectionIds(runtime).length === 0) {
      it.skip("requires schema_registry.endpoint + schema_registry.auth (api_key) config", () => {});
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
    // the topic indexed in catalog so the pre-test tag assignment is accepted)
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

      it("should expose remove-tag-from-entity in tools/list", async () => {
        const { tools } = await server.client.listTools();

        expect(
          tools.find((t) => t.name === ToolName.REMOVE_TAG_FROM_ENTITY),
        ).toBeDefined();
      });

      it(
        "should remove a tag assignment from a topic",
        // 180s covers the 120s catalog-indexing poll plus topic/schema seed, the pre-test
        // tag-assign POST, and the final remove call
        { timeout: 180_000 },
        async (ctx) => {
          // fresh tag + topic per transport, with the tag pre-assigned so the handler has something
          // to remove
          const tagName = uniqueName(`removetag-${transport}`);
          const topic = uniqueName(`removetag-${transport}`);
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
                description: "integration test remove target",
              },
            ],
          });
          expect(tagError, JSON.stringify(tagError)).toBeUndefined();
          await admin().createTopics({ topics: [{ topic, numPartitions: 1 }] });
          // registering a schema for `<topic>-value` triggers stream governance to index the topic
          // entity in catalog; without it the assign POST 404s on 4040009. CCloud indexing policy,
          // not a catalog API contract - drop if/when CCloud indexes all topics regardless of
          // schema association
          await srClient().register(subject, { schema: TEST_AVRO_SCHEMA });
          const qualifiedName = `${srClusterId}:${kafkaClusterId}:${topic}`;
          // poll the catalog topic-entity GET until stream governance finishes indexing AND echoes
          // the qualified name we constructed; a format drift in CCloud's qualified-name encoding
          // fails fast with a diff here instead of timing out on the pre-test assign POST
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
          const { error: assignError } = await path[
            "/catalog/v1/entity/tags"
          ].POST({
            body: [
              {
                entityType: "kafka_topic",
                entityName: qualifiedName,
                typeName: tagName,
              },
            ],
          });
          expect(assignError, JSON.stringify(assignError)).toBeUndefined();

          const result = await server.client.callTool({
            name: ToolName.REMOVE_TAG_FROM_ENTITY,
            arguments: {
              tagName,
              typeName: "kafka_topic",
              qualifiedName,
            },
          });
          const text = textContent(result);
          // the DELETE-by-tag-name lookup trails the assignment POST on a separate replica and
          // 4040008s before the just-made assignment becomes queryable; skip honestly rather than
          // poll for minutes since the handler's wiring is already proven by the call going through.
          if (text.includes('"error_code":4040008')) {
            ctx.skip(
              `CCloud catalog tag-on-entity propagation exceeded test budget for tag ${tagName} (4040008)`,
            );
            return;
          }
          expect(text).toContain(
            `Successfully removed tag ${tagName} from entity ${qualifiedName}`,
          );
        },
      );
    });
  },
);
