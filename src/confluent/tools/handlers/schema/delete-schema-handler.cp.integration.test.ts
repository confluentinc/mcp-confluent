import { DeleteSchemaHandler } from "@src/confluent/tools/handlers/schema/delete-schema-handler.js";
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

const handler = new DeleteSchemaHandler();
const runtime = cpIntegrationRuntime();

/** Schema Registry base URL for the local CP stack. */
const SR_BASE = "http://localhost:8081";

/**
 * Registers a minimal Avro schema under a test subject via the SR HTTP API.
 * Returns the subject name so the caller can track it for cleanup.
 */
async function registerTestSubject(subject: string): Promise<void> {
  const body = JSON.stringify({
    schema: JSON.stringify({ type: "string" }),
    schemaType: "AVRO",
  });
  const resp = await fetch(`${SR_BASE}/subjects/${subject}/versions`, {
    method: "POST",
    headers: { "Content-Type": "application/vnd.schemaregistry.v1+json" },
    body,
  });
  if (!resp.ok) {
    throw new Error(
      `Failed to register test subject "${subject}": ${resp.status} ${await resp.text()}`,
    );
  }
}

/** Hard-deletes a subject via the SR HTTP API (used in teardown). */
async function hardDeleteSubject(subject: string): Promise<void> {
  // soft-delete first, then permanent delete; ignore 404s
  await fetch(`${SR_BASE}/subjects/${subject}`, { method: "DELETE" }).catch(
    () => {},
  );
  await fetch(`${SR_BASE}/subjects/${subject}?permanent=true`, {
    method: "DELETE",
  }).catch(() => {});
}

describe(
  "delete-schema-handler (Confluent Platform)",
  { tags: [Tag.CP] },
  () => {
    if (handler.enabledConnectionIds(runtime).length === 0) {
      it.skip("requires schema_registry config (start docker-compose.cp-test.yml and set CP_KAFKA_USERNAME + CP_KAFKA_PASSWORD)", () => {});
      return;
    }

    describe.each(activeTransports)("via %s transport", (transport) => {
      let server: StartedServer;
      // unique subject per transport iteration so parallel runs don't collide
      const subject = `int-cp-delete-schema-${transport}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      beforeAll(async () => {
        await registerTestSubject(subject);
        server = await startCpServer({ transport });
      });

      afterAll(async () => {
        await server?.stop();
        // permanent cleanup in case the tool only soft-deleted
        await hardDeleteSubject(subject);
      });

      it("should soft-delete the test subject from the CP Schema Registry", async () => {
        const result = await server.client.callTool({
          name: ToolName.DELETE_SCHEMA,
          arguments: { subject, permanent: false },
        });

        expect(result.isError).not.toBe(true);
        expect(textContent(result)).toMatch(
          new RegExp(`Successfully deleted subject "${subject}"`),
        );
      });
    });
  },
);
