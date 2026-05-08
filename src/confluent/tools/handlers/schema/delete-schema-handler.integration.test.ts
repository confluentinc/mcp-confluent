import { DeleteSchemaHandler } from "@src/confluent/tools/handlers/schema/delete-schema-handler.js";
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

const handler = new DeleteSchemaHandler();
const runtime = integrationRuntime();

describe("delete-schema-handler", { tags: [Tag.SCHEMA] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires schema_registry.endpoint + schema_registry.auth config", () => {});
    return;
  }

  // installs beforeAll/afterAll at this describe scope (shared SR client, subject cleanup)
  const { client, createdSubjects } = withSharedSrClient();

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should soft-delete a registered subject", async () => {
      // create a new schema+subject before we try to delete it
      const subject = uniqueName(`delete-${transport}`);
      createdSubjects.push(subject);
      await client().register(subject, { schema: TEST_AVRO_SCHEMA });
      // SR's listing is eventually consistent; poll until the new subject is visible before deleting
      await expect
        .poll(() => client().getAllSubjects(), {
          timeout: 15_000,
          interval: 500,
        })
        .toContain(subject);

      const result = await server.client.callTool({
        name: ToolName.DELETE_SCHEMA,
        arguments: { subject },
      });

      expect(textContent(result)).toContain(
        `Successfully deleted subject "${subject}"`,
      );
      // a soft delete removes the subject from the default `getAllSubjects()` listing
      await expect
        .poll(() => client().getAllSubjects(), {
          timeout: 15_000,
          interval: 500,
        })
        .not.toContain(subject);
    });
  });
});
