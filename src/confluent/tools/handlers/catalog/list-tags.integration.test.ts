import { ListTagsHandler } from "@src/confluent/tools/handlers/catalog/list-tags.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { integrationConnection } from "@tests/harness/runtime.js";
import { skipIfDisabled } from "@tests/harness/skip-gate.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListTagsHandler();

describe(
  "list-tags-handler",
  { tags: [Tag.CATALOG, Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG] },
  () => {
    if (skipIfDisabled(handler, integrationConnection())) {
      return;
    }

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose list-tags in tools/list", async () => {
        const { tools } = await server.client.listTools();

        expect(tools.find((t) => t.name === ToolName.LIST_TAGS)).toBeDefined();
      });

      // CCloud's tagdef list endpoint trails the create write by enough that asserting on a
      // freshly-seeded tag flakes; the prefix check proves the handler is wired and parses the
      // response shape.
      it("should return a successful response", async () => {
        const result = await server.client.callTool({
          name: ToolName.LIST_TAGS,
          arguments: {},
        });

        expect(textContent(result)).toMatch(/^Successfully retrieved tags:/);
      });
    });
  },
);
