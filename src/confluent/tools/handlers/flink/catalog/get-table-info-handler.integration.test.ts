import { GetTableInfoHandler } from "@src/confluent/tools/handlers/flink/catalog/get-table-info-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { findFriendlySchemaName } from "@tests/harness/flink.js";
import {
  getTestClusterId,
  withSharedAdminClient,
} from "@tests/harness/kafka-admin.js";
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

const handler = new GetTableInfoHandler();
const runtime = integrationRuntime();

describe("get-table-info-handler", { tags: [Tag.FLINK] }, () => {
  if (handler.enabledConnectionIds(runtime).length === 0) {
    it.skip("requires flink config", () => {});
    return;
  }

  // installs beforeAll/afterAll at this describe scope (admin client + topic cleanup)
  const { admin, createdTopics } = withSharedAdminClient();
  const tableName = uniqueName("flink-tbl");

  beforeAll(async () => {
    createdTopics.push(tableName);
    await admin().createTopics({
      topics: [{ topic: tableName, numPartitions: 1 }],
    });
  });

  describe.each(activeTransports)("via %s transport", (transport) => {
    let server: StartedServer;

    beforeAll(async () => {
      server = await startServer({ transport });
    });

    afterAll(async () => {
      await server?.stop();
    });

    it("should expose get-flink-table-info in tools/list", async () => {
      const { tools } = await server.client.listTools();

      expect(
        tools.find((t) => t.name === ToolName.GET_FLINK_TABLE_INFO),
      ).toBeDefined();
    });

    it("should return metadata for the seeded kafka-backed table", async () => {
      // catalog SQL filter uses TABLE_SCHEMA (friendly name), not the lkc-* id, so we need to
      // resolve the friendly name via list-databases
      const dbResult = await server.client.callTool({
        name: ToolName.LIST_FLINK_DATABASES,
        arguments: {},
      });
      expect(
        dbResult.isError,
        `list-databases failed: ${textContent(dbResult)}`,
      ).not.toBe(true);
      const databaseName = findFriendlySchemaName(
        textContent(dbResult),
        getTestClusterId(),
      );
      expect(
        databaseName,
        `kafka cluster ${getTestClusterId()} not catalogued in Flink workspace. Verify flink.compute_pool_id is in the same region/provider as the kafka cluster (see test-fixtures/yaml_configs/integration.yaml).`,
      ).toBeDefined();

      // CCloud may take a while to auto-discover kafka topics as Flink tables
      await expect
        .poll(
          async () => {
            const result = await server.client.callTool({
              name: ToolName.GET_FLINK_TABLE_INFO,
              arguments: { tableName, databaseName },
            });
            if (result.isError === true) throw new Error(textContent(result));
            return textContent(result);
          },
          { timeout: 90_000, interval: 5_000 },
        )
        .toContain(`Table info for '${tableName}':`);
    }, 120_000);
  });
});
