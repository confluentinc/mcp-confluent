import { CREATE_UPDATE } from "@src/confluent/tools/base-tools.js";
import { UpdateConnectorConfigHandler } from "@src/confluent/tools/handlers/connect/update-connector-config-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  CCLOUD_CONN,
  CONNECT_CONN,
  ConnectHandleCase,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const connectorConfig = {
  "connector.class": "S3_SINK",
  "tasks.max": "2",
  topics: "events",
};

describe("update-connector-config-handler.ts", () => {
  describe("UpdateConnectorConfigHandler", () => {
    const handler = new UpdateConnectorConfigHandler();

    describe("getToolConfig()", () => {
      it("should return UPDATE_CONNECTOR_CONFIG with CREATE_UPDATE annotations", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.UPDATE_CONNECTOR_CONFIG);
        expect(config.annotations).toBe(CREATE_UPDATE);
      });
    });

    describe("handle()", () => {
      const cases: ConnectHandleCase[] = [
        {
          label:
            "send the connector config as the PUT body, falling back to conn kafka env_id and cluster_id when args are absent",
          connectionConfig: CONNECT_CONN,
          args: { connectorName: "my-connector", connectorConfig },
          mockResponse: {
            data: { name: "my-connector", config: connectorConfig },
          },
          outcome: { resolves: "my-connector config updated" },
          expectedEnvId: "env-from-config",
          expectedClusterId: "lkc-from-config",
        },
        {
          label:
            "prefer explicit environmentId and clusterId args over conn config",
          connectionConfig: CONNECT_CONN,
          args: {
            connectorName: "my-connector",
            connectorConfig,
            environmentId: "env-from-arg",
            clusterId: "lkc-from-arg",
          },
          mockResponse: {
            data: { name: "my-connector", config: connectorConfig },
          },
          outcome: { resolves: "my-connector config updated" },
          expectedEnvId: "env-from-arg",
          expectedClusterId: "lkc-from-arg",
        },
        {
          label: "throw when environment_id is absent from both arg and config",
          connectionConfig: CCLOUD_CONN,
          args: { connectorName: "my-connector", connectorConfig },
          outcome: { throws: "Environment ID is required" },
        },
        {
          label:
            "throw when kafka_cluster_id is absent from both arg and config",
          connectionConfig: {
            ...CCLOUD_CONN,
            kafka: {
              env_id: "env-from-config",
              rest_endpoint: "https://pkc-example.confluent.cloud:443",
            },
          },
          args: { connectorName: "my-connector", connectorConfig },
          outcome: { throws: "Kafka Cluster ID is required" },
        },
        {
          label: "resolve with an error message when the API returns an error",
          connectionConfig: CONNECT_CONN,
          args: { connectorName: "my-connector", connectorConfig },
          mockResponse: { error: { error_code: 409, message: "conflict" } },
          outcome: {
            resolves: "Failed to update connector my-connector config",
          },
          expectedEnvId: "env-from-config",
          expectedClusterId: "lkc-from-config",
        },
      ];

      it.each(cases)(
        "should $label",
        async ({
          connectionConfig: connConfig = {},
          args,
          mockResponse,
          outcome,
          expectedEnvId,
          expectedClusterId,
        }) => {
          const clientManager = getMockedClientManager();
          const cloudRest = clientManager.getConfluentCloudRestClient();
          if (mockResponse !== undefined) {
            cloudRest.PUT.mockResolvedValue(mockResponse);
          }

          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              connConfig,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientManager,
          });

          if (typeof outcome === "object" && "resolves" in outcome) {
            expect(cloudRest.PUT).toHaveBeenCalledOnce();
            expect(cloudRest.PUT).toHaveBeenCalledWith(
              expect.any(String),
              expect.objectContaining({
                params: expect.objectContaining({
                  path: expect.objectContaining({
                    connector_name: "my-connector",
                    environment_id: expectedEnvId,
                    kafka_cluster_id: expectedClusterId,
                  }),
                }),
                // The flat config map must be the body, not wrapped in a {name, config} envelope.
                body: connectorConfig,
              }),
            );
          }
        },
      );
    });
  });
});
