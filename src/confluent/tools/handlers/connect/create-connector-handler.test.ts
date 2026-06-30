import { MCPServerConfiguration } from "@src/config/models.js";
import { CreateConnectorHandler } from "@src/confluent/tools/handlers/connect/create-connector-handler.js";
import { ServerRuntime } from "@src/server-runtime.js";
import {
  CCLOUD_CONN,
  CONNECT_CONN_WITH_AUTH,
  ConnectHandleCase,
  DEFAULT_CONNECTION_ID,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  type MockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const MINIMAL_CONNECTOR_ARGS = {
  connectorName: "my-connector",
  connectorConfig: { "connector.class": "BigQuerySink" },
};

describe("create-connector-handler.ts", () => {
  describe("CreateConnectorHandler", () => {
    const handler = new CreateConnectorHandler();

    describe("handle()", () => {
      const cases: ConnectHandleCase[] = [
        {
          label:
            "fall back to conn kafka env_id and cluster_id when args are absent",
          connectionConfig: CONNECT_CONN_WITH_AUTH,
          args: MINIMAL_CONNECTOR_ARGS,
          mockResponse: { data: { name: "my-connector" } },
          outcome: { resolves: "my-connector created" },
          expectedEnvId: "env-from-config",
          expectedClusterId: "lkc-from-config",
        },
        {
          label:
            "prefer explicit environmentId and clusterId args over conn config",
          connectionConfig: CONNECT_CONN_WITH_AUTH,
          args: {
            ...MINIMAL_CONNECTOR_ARGS,
            environmentId: "env-from-arg",
            clusterId: "lkc-from-arg",
          },
          mockResponse: { data: { name: "my-connector" } },
          outcome: { resolves: "my-connector created" },
          expectedEnvId: "env-from-arg",
          expectedClusterId: "lkc-from-arg",
        },
        {
          label: "throw when environment_id is absent from both arg and config",
          connectionConfig: {
            ...CCLOUD_CONN,
            kafka: {
              cluster_id: "lkc-from-config",
              rest_endpoint: "https://pkc-example.confluent.cloud:443",
              auth: { type: "api_key" as const, key: "k", secret: "s" },
            },
          },
          args: MINIMAL_CONNECTOR_ARGS,
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
              auth: { type: "api_key" as const, key: "k", secret: "s" },
            },
          },
          args: MINIMAL_CONNECTOR_ARGS,
          outcome: { throws: "Kafka Cluster ID is required" },
        },
        {
          label: "resolve with an error message when the API returns an error",
          connectionConfig: CONNECT_CONN_WITH_AUTH,
          args: MINIMAL_CONNECTOR_ARGS,
          mockResponse: { error: { message: "connector already exists" } },
          outcome: { resolves: "Failed to create connector my-connector" },
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
            runtime: runtimeWithDecoy(
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
                    environment_id: expectedEnvId,
                    kafka_cluster_id: expectedClusterId,
                  }),
                }),
              }),
            );
          }
        },
      );

      it("should embed kafka auth credentials from conn config in the POST body", async () => {
        const clientManager = getMockedClientManager();
        const cloudRest = clientManager.getConfluentCloudRestClient();
        cloudRest.POST.mockResolvedValue({ data: { name: "my-connector" } });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CONNECT_CONN_WITH_AUTH,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: MINIMAL_CONNECTOR_ARGS,
          outcome: { resolves: "my-connector created" },
          clientManager,
        });

        expect(cloudRest.POST).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({
              config: expect.objectContaining({
                "kafka.api.key": "kafka-key",
                "kafka.api.secret": "kafka-secret",
              }),
            }),
          }),
        );
      });

      it("should prefer explicit kafkaApiKey/kafkaApiSecret args over conn config in the POST body", async () => {
        const clientManager = getMockedClientManager();
        const cloudRest = clientManager.getConfluentCloudRestClient();
        cloudRest.POST.mockResolvedValue({ data: { name: "my-connector" } });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CONNECT_CONN_WITH_AUTH,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {
            ...MINIMAL_CONNECTOR_ARGS,
            kafkaApiKey: "arg-key",
            kafkaApiSecret: "arg-secret",
          },
          outcome: { resolves: "my-connector created" },
          clientManager,
        });

        expect(cloudRest.POST).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            body: expect.objectContaining({
              config: expect.objectContaining({
                "kafka.api.key": "arg-key",
                "kafka.api.secret": "arg-secret",
              }),
            }),
          }),
        );
      });
    });

    // Under OAuth there is no kafka block to source the embedded keypair from,
    // so the tool requires kafkaApiKey/kafkaApiSecret (plus environmentId and
    // clusterId) as explicit arguments. The REST call itself rides the OAuth
    // bearer middleware like every other Connect tool.
    describe("handle() under an OAuth connection", () => {
      const OAUTH_ARGS = {
        ...MINIMAL_CONNECTOR_ARGS,
        environmentId: "env-from-arg",
        clusterId: "lkc-from-arg",
        kafkaApiKey: "arg-key",
        kafkaApiSecret: "arg-secret",
      };

      function oauthRuntime(clientManager: MockedClientManager): ServerRuntime {
        return new ServerRuntime(
          new MCPServerConfiguration({
            connections: {
              [DEFAULT_CONNECTION_ID]: { type: "oauth", ccloud_env: "devel" },
            },
          }),
          { [DEFAULT_CONNECTION_ID]: clientManager },
        );
      }

      it("should embed the keypair from explicit args in the POST body", async () => {
        const clientManager = getMockedClientManager();
        const cloudRest = clientManager.getConfluentCloudRestClient();
        cloudRest.POST.mockResolvedValue({ data: { name: "my-connector" } });

        const result = await handler.handle(
          oauthRuntime(clientManager),
          OAUTH_ARGS,
        );

        expect(result.isError).toBeFalsy();
        expect(cloudRest.POST).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            params: expect.objectContaining({
              path: expect.objectContaining({
                environment_id: "env-from-arg",
                kafka_cluster_id: "lkc-from-arg",
              }),
            }),
            body: expect.objectContaining({
              config: expect.objectContaining({
                "kafka.api.key": "arg-key",
                "kafka.api.secret": "arg-secret",
              }),
            }),
          }),
        );
      });

      it("should throw when kafkaApiKey is missing", async () => {
        const clientManager = getMockedClientManager();
        const { kafkaApiKey: _omitted, ...argsWithoutKey } = OAUTH_ARGS;

        await expect(
          handler.handle(oauthRuntime(clientManager), argsWithoutKey),
        ).rejects.toThrow("Kafka API Key is required");
        expect(
          clientManager.getConfluentCloudRestClient().POST,
        ).not.toHaveBeenCalled();
      });

      it("should throw when kafkaApiSecret is missing", async () => {
        const clientManager = getMockedClientManager();
        const { kafkaApiSecret: _omitted, ...argsWithoutSecret } = OAUTH_ARGS;

        await expect(
          handler.handle(oauthRuntime(clientManager), argsWithoutSecret),
        ).rejects.toThrow("Kafka API Secret is required");
        expect(
          clientManager.getConfluentCloudRestClient().POST,
        ).not.toHaveBeenCalled();
      });
    });
  });
});
