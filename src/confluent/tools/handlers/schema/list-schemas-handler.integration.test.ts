import { ListSchemasHandler } from "@src/confluent/tools/handlers/schema/list-schemas-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import {
  TEST_AVRO_SCHEMA,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListSchemasHandler();
const runtime = integrationRuntime();

describe("list-schemas-handler", { tags: [Tag.SCHEMA] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires schema_registry.endpoint + schema_registry.auth config", () => {});
    return;
  }

  // installs beforeAll/afterAll at this describe scope (shared SR client, subject cleanup)
  const { client, createdSubjects } = withSharedSrClient();
  const subject = uniqueName("list");

  // seed one subject so the assertion still fires against a brand-new empty registry
  beforeAll(async () => {
    await client().register(subject, { schema: TEST_AVRO_SCHEMA });
    createdSubjects.push(subject);
  });

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should expose list-schemas in tools/list", async () => {
      const { tools } = await server.client.listTools();

      const listSchemas = tools.find((t) => t.name === ToolName.LIST_SCHEMAS);
      expect(listSchemas).toBeDefined();
    });

    it("should return a subject map that includes the seeded subject", async () => {
      const result = await server.client.callTool({
        name: ToolName.LIST_SCHEMAS,
        arguments: { subjectPrefix: subject },
      });

      expect(result.isError).not.toBe(true);
      // handler stringifies a `Record<subject, metadata>` map; the prefix filter narrows the
      // response to a single-key object
      const parsed = JSON.parse(textContent(result));
      expect(parsed).toHaveProperty(subject);
    });
  });
});
