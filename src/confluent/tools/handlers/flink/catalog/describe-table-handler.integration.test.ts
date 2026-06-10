import { DescribeTableHandler } from "@src/confluent/tools/handlers/flink/catalog/describe-table-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  findFriendlySchemaName,
  trackStatementsFromMeta,
  withSharedFlinkStatementCleanup,
} from "@tests/harness/flink.js";
import {
  getTestClusterId,
  withSharedAdminClient,
} from "@tests/harness/kafka-admin.js";
import {
  integrationConnection,
  integrationRuntime,
} from "@tests/harness/runtime.js";
import { skipIfDisabled } from "@tests/harness/skip-gate.js";
import {
  startServer,
  type StartedServer,
} from "@tests/harness/start-server.js";
import { textContent } from "@tests/harness/tool-results.js";
import { activeTransports } from "@tests/harness/transports.js";
import { uniqueName } from "@tests/harness/unique-name.js";
import { Tag } from "@tests/tags.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const handler = new DescribeTableHandler();
const runtime = integrationRuntime();

describe(
  "describe-table-handler",
  {
    tags: [
      Tag.FLINK,
      Tag.REQUIRES_FLINK_CONFIG,
      Tag.REQUIRES_CONFLUENT_CLOUD_CONFIG,
    ],
  },
  () => {
    if (skipIfDisabled(handler, integrationConnection())) {
      return;
    }

    // also provisions a kafka topic and addresses it by cluster id, so gate
    // explicitly on the kafka fields the flink predicate doesn't cover
    const conn = runtime.config.getSoleDirectConnection();
    if (
      !conn.kafka?.bootstrap_servers ||
      !conn.kafka.auth ||
      !conn.kafka.cluster_id
    ) {
      it.skip("requires kafka.bootstrap_servers + kafka.auth + kafka.cluster_id config", () => {});
      return;
    }

    // installs beforeAll/afterAll at this describe scope (admin client + topic cleanup)
    const { admin, createdTopics } = withSharedAdminClient();
    // sweeps mcp-query-* statements surfaced via _meta.flinkStatementsCreated.
    // expect.poll() retries grow the array with every attempt (all leaks land
    // in the sweep, not just the final one).
    const { createdStatements } = withSharedFlinkStatementCleanup();
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

      it("should expose describe-flink-table in tools/list", async () => {
        const { tools } = await server.client.listTools();

        expect(
          tools.find((t) => t.name === ToolName.DESCRIBE_FLINK_TABLE),
        ).toBeDefined();
      });

      it("should return both the column schema and table metadata for the seeded kafka-backed table", async () => {
        // catalog SQL filter uses TABLE_SCHEMA (friendly name), not the lkc-* id, so we need to
        // resolve the friendly name via list-databases
        const dbResult = await server.client.callTool({
          name: ToolName.LIST_FLINK_DATABASES,
          arguments: {},
        });
        trackStatementsFromMeta(dbResult, createdStatements);
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
        let describeText = "";
        await expect
          .poll(
            async () => {
              const result = await server.client.callTool({
                name: ToolName.DESCRIBE_FLINK_TABLE,
                arguments: { tableName, databaseName },
              });
              trackStatementsFromMeta(result, createdStatements);
              if (result.isError === true) throw new Error(textContent(result));
              describeText = textContent(result);
              return describeText;
            },
            { timeout: 90_000, interval: 5_000 },
          )
          .toContain(`Table '${tableName}':`);

        // merged tool: column schema (COLUMNS) and table metadata (TABLES) in one payload
        expect(describeText).toContain("COLUMN_NAME");
        expect(describeText).toContain("IS_WATERMARKED");
      }, 120_000);
    });
  },
);
