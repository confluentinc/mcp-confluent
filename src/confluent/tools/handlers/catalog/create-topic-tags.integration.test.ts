import { CreateTopicTagsHandler } from "@src/confluent/tools/handlers/catalog/create-topic-tags.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { integrationConnection } from "@tests/harness/runtime.js";
import { withSharedCatalogTagsClient } from "@tests/harness/schema-registry.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new CreateTopicTagsHandler();

describe(
  "create-topic-tags-handler",
  { tags: [Tag.CATALOG, Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG] },
  () => {
    const verdict = handler.predicate(integrationConnection());
    if (!verdict.enabled) {
      it.skip(verdict.reason, () => {});
      return;
    }

    // installs beforeAll/afterAll at this describe scope (shared SR REST client, tag cleanup)
    const { createdTags } = withSharedCatalogTagsClient();

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose create-topic-tags in tools/list", async () => {
        const { tools } = await server.client.listTools();

        expect(
          tools.find((t) => t.name === ToolName.CREATE_TOPIC_TAGS),
        ).toBeDefined();
      });

      it("should create a tag and return it in the response", async () => {
        // fresh tag per transport so each iteration has a clean POST target
        const tagName = uniqueName(`create-${transport}`);
        createdTags.push(tagName);

        const result = await server.client.callTool({
          name: ToolName.CREATE_TOPIC_TAGS,
          arguments: {
            tags: [{ tagName, description: "integration test create" }],
          },
        });

        expect(textContent(result)).toMatch(/^Successfully created tag:/);
        expect(textContent(result)).toContain(tagName);
      });
    });
  },
);
