import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// One URL per parser branch — failures usually point upstream, not at our code.
const cases = [
  {
    label: "docs.confluent.io .md twin",
    url: "https://docs.confluent.io/platform/current/installation/overview.html",
    expectMarkdown: /confluent platform/i,
  },
  {
    label: "developer.confluent.io Swiftype body",
    url: "https://developer.confluent.io/courses/apache-kafka/events/",
    expectMarkdown: /event/i,
  },
  {
    label: "developer.confluent.io page-data fallback",
    url: "https://developer.confluent.io/get-started/python/",
    expectMarkdown: /python/i,
  },
  {
    label: "support.confluent.io Zendesk JSON API",
    url: "https://support.confluent.io/hc/en-us/articles/35347366787732-What-s-causing-Connector-failed-because-of-it-encountered-some-bad-records-Error-using-MySQL-Sink-Connector-on-Confluent-Cloud",
    expectMarkdown: /connector/i,
  },
] as const;

describe(
  "get-product-doc-page-handler",
  { tags: [Tag.DOCS, Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG] },
  () => {
    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose get-product-doc-page in tools/list", async () => {
        const { tools } = await server.client.listTools();
        expect(
          tools.find((t) => t.name === ToolName.GET_PRODUCT_DOC_PAGE),
        ).toBeDefined();
      });

      it.each(cases)(
        "should fetch and render markdown from $label",
        async ({ url, expectMarkdown }) => {
          const result = await server.client.callTool({
            name: ToolName.GET_PRODUCT_DOC_PAGE,
            arguments: { url },
          });

          const text = textContent(result);
          expect(text).toContain(`# Source: ${url}`);
          // Above the bare `# Source` header — proves we got a body.
          expect(text.length).toBeGreaterThan(500);
          expect(text).toMatch(expectMarkdown);
        },
      );
    });
  },
);
