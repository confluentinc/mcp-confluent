import { ListFlinkStatementsHandler } from "@src/confluent/tools/handlers/flink/list-flink-statements-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  provisionTestFlinkStatement,
  withSharedFlinkStatementCleanup,
} from "@tests/harness/flink.js";
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

const handler = new ListFlinkStatementsHandler();
const runtime = integrationRuntime();

describe(
  "list-flink-statements-handler",
  {
    tags: [
      Tag.FLINK,
      Tag.REQUIRES_FLINK_CONFIG,
      Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG,
    ],
  },
  () => {
    if (handler.enabledConnectionIds(runtime).length === 0) {
      it.skip("requires flink config", () => {});
      return;
    }

    // installs afterAll at this describe scope (tracks the seed statement for delete)
    const { createdStatements } = withSharedFlinkStatementCleanup();
    const seedName = uniqueName("list-stmts");

    beforeAll(async () => {
      await provisionTestFlinkStatement(seedName);
      createdStatements.push(seedName);
    });

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose list-flink-statements in tools/list", async () => {
        const { tools } = await server.client.listTools();

        expect(
          tools.find((t) => t.name === ToolName.LIST_FLINK_STATEMENTS),
        ).toBeDefined();
      });

      it("should return a JSON payload that includes the seeded statement", async () => {
        // Pagination guard: the test account is shared, so accumulated state (e.g. `mcp-query-*`
        // from catalog handler leaks) can push the seed off the first page of 100. Walk pages until
        // we find it, with a cap.
        const MAX_PAGES = 20;
        let pageToken: string | undefined;
        let pagesChecked = 0;
        let found = false;
        let totalSeen = 0;

        do {
          const result = await server.client.callTool({
            name: ToolName.LIST_FLINK_STATEMENTS,
            arguments: pageToken ? { pageToken } : {},
          });
          const text = textContent(result);
          const body = JSON.parse(text) as {
            data?: Array<{ name: string }>;
            metadata?: { next?: string };
          };
          const names = body.data?.map((s) => s.name) ?? [];
          totalSeen += names.length;
          if (names.includes(seedName)) {
            found = true;
            break;
          }
          pageToken = extractPageToken(body.metadata?.next);
          pagesChecked++;
        } while (pageToken && pagesChecked < MAX_PAGES);

        expect(
          found,
          `seed statement ${seedName} not found after scanning ${totalSeen} statement(s) across ${pagesChecked} page(s). Check to make sure statements are not piling up in the test environment.`,
        ).toBe(true);
      });
    });
  },
);

/**
 * Extracts the `page_token` from a CCloud `metadata.next` value, falling back
 * to a substring search since CCloud returns both full URLs and bare tokens.
 */
function extractPageToken(nextUrl: string | undefined): string | undefined {
  if (!nextUrl) return undefined;
  try {
    return new URL(nextUrl).searchParams.get("page_token") ?? undefined;
  } catch {
    const idx = nextUrl.indexOf("page_token=");
    return idx === -1 ? undefined : nextUrl.slice(idx + "page_token=".length);
  }
}
