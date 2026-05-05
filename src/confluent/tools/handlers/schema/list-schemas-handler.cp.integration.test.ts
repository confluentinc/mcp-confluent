import { ListSchemasHandler } from "@src/confluent/tools/handlers/schema/list-schemas-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { cpIntegrationRuntime } from "@tests/harness/cp-runtime.js";
import {
  startCpServer,
  type StartedServer,
} from "@tests/harness/cp-start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new ListSchemasHandler();
const runtime = cpIntegrationRuntime();

describe(
  "list-schemas-handler (Confluent Platform)",
  { tags: [Tag.CP] },
  () => {
    if (handler.enabledConnectionIds(runtime).length === 0) {
      it.skip("requires schema_registry config (start docker-compose.cp-test.yml and set CP_KAFKA_USERNAME + CP_KAFKA_PASSWORD)", () => {});
      return;
    }

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;

      beforeAll(async () => {
        server = await startCpServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
      });

      it("should expose list-schemas in tools/list", async () => {
        const { tools } = await server.client.listTools();

        const listSchemas = tools.find((t) => t.name === ToolName.LIST_SCHEMAS);
        expect(listSchemas).toBeDefined();
      });

      it("should return schema listing from the CP Schema Registry", async () => {
        const result = await server.client.callTool({
          name: ToolName.LIST_SCHEMAS,
          arguments: { latestOnly: true },
        });

        expect(result.isError).not.toBe(true);
        // handler returns a JSON object (empty `{}` when no subjects exist,
        // or a map of subject → schema metadata). Either way the result is
        // valid JSON and the call succeeded end-to-end.
        const text = textContent(result);
        expect(() => JSON.parse(text)).not.toThrow();
      });
    });
  },
);
