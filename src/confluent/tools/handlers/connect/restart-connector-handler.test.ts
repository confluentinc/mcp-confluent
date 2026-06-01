import { CREATE_UPDATE } from "@src/confluent/tools/base-tools.js";
import { RestartConnectorHandler } from "@src/confluent/tools/handlers/connect/restart-connector-handler.js";
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

describe("restart-connector-handler.ts", () => {
  describe("RestartConnectorHandler", () => {
    const handler = new RestartConnectorHandler();

    describe("getToolConfig()", () => {
      it("should return RESTART_CONNECTOR with CREATE_UPDATE annotations", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.RESTART_CONNECTOR);
        expect(config.annotations).toBe(CREATE_UPDATE);
      });
    });

    describe("handle()", () => {
      const cases: ConnectHandleCase[] = [
        {
          label:
            "issue a POST to the restart path, falling back to conn kafka env_id and cluster_id when args are absent",
          connectionConfig: CONNECT_CONN,
          args: { connectorName: "my-connector" },
          mockResponse: {},
          outcome: { resolves: "Restart requested for connector my-connector" },
          expectedEnvId: "env-from-config",
          expectedClusterId: "lkc-from-config",
        },
        {
          label:
            "prefer explicit environmentId and clusterId args over conn config",
          connectionConfig: CONNECT_CONN,
          args: {
            connectorName: "my-connector",
            environmentId: "env-from-arg",
            clusterId: "lkc-from-arg",
          },
          mockResponse: {},
          outcome: { resolves: "Restart requested for connector my-connector" },
          expectedEnvId: "env-from-arg",
          expectedClusterId: "lkc-from-arg",
        },
        {
          label: "throw when environment_id is absent from both arg and config",
          connectionConfig: CCLOUD_CONN,
          args: { connectorName: "my-connector" },
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
          args: { connectorName: "my-connector" },
          outcome: { throws: "Kafka Cluster ID is required" },
        },
        {
          label: "resolve with an error message when the API returns an error",
          connectionConfig: CONNECT_CONN,
          args: { connectorName: "my-connector" },
          mockResponse: { error: { error_code: 500, message: "boom" } },
          outcome: { resolves: "Failed to restart connector my-connector" },
          expectedEnvId: "env-from-config",
          expectedClusterId: "lkc-from-config",
        },
      ];

      it.each(cases)(
        "should $label",
        async ({
          connectionConfig = {},
          args,
          mockResponse,
          outcome,
          expectedEnvId,
          expectedClusterId,
        }) => {
          const clientManager = getMockedClientManager();
          const cloudRest = clientManager.getConfluentCloudRestClient();
          if (mockResponse !== undefined) {
            cloudRest.POST.mockResolvedValue(mockResponse);
          }

          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              connectionConfig,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientManager,
          });

          if (typeof outcome === "object" && "resolves" in outcome) {
            expect(cloudRest.POST).toHaveBeenCalledOnce();
            expect(cloudRest.POST).toHaveBeenCalledWith(
              expect.any(String),
              expect.objectContaining({
                params: expect.objectContaining({
                  path: expect.objectContaining({
                    connector_name: "my-connector",
                    environment_id: expectedEnvId,
                    kafka_cluster_id: expectedClusterId,
                  }),
                }),
              }),
            );
          }
        },
      );
    });
  });
});
