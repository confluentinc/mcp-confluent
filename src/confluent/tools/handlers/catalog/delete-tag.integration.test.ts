import { DeleteTagHandler } from "@src/confluent/tools/handlers/catalog/delete-tag.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { integrationConnection } from "@tests/harness/runtime.js";
import { withSharedCatalogTagsClient } from "@tests/harness/schema-registry.js";
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

const handler = new DeleteTagHandler();

describe(
  "delete-tag-handler",
  { tags: [Tag.CATALOG, Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG] },
  () => {
    if (skipIfNotEnabled(handler, integrationConnection())) {
      return;
    }

    // installs beforeAll/afterAll at this describe scope (shared SR REST client, tag cleanup)
    const { client, createdTags } = withSharedCatalogTagsClient();

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose delete-tag in tools/list", async () => {
        const { tools } = await server.client.listTools();

        expect(tools.find((t) => t.name === ToolName.DELETE_TAG)).toBeDefined();
      });

      it(
        "should delete a pre-existing tag",
        // CCloud's DELETE-by-name waits on the tagdef-by-name replica that trails the create
        // write; on cold runs the request can take 3+ minutes to return 4040001 or success
        { timeout: 300_000 },
        async (ctx) => {
          // seed a fresh tag per transport so each iteration has its own delete target
          const tagName = uniqueName(`delete-${transport}`);
          createdTags.push(tagName);
          const path = wrapAsPathBasedClient(client());
          const { error: seedError } = await path[
            "/catalog/v1/types/tagdefs"
          ].POST({
            body: [
              {
                entityTypes: ["kafka_topic"],
                name: tagName,
                description: "integration test delete target",
              },
            ],
          });
          expect(seedError, JSON.stringify(seedError)).toBeUndefined();

          const result = await server.client.callTool({
            name: ToolName.DELETE_TAG,
            arguments: { tagName },
          });
          const text = textContent(result);
          // the DELETE handler hits the same lagged replica and 404s before tagdef create
          // propagates; skip honestly rather than fail. afterAll cleanup re-runs DELETE later so
          // state stays clean.
          if (text.includes('"error_code":4040001')) {
            ctx.skip(
              `CCloud catalog tagdef propagation exceeded test budget for tag ${tagName} (4040001)`,
            );
            return;
          }
          expect(text).toContain(`Successfully deleted tag: ${tagName}`);
        },
      );
    });
  },
);
