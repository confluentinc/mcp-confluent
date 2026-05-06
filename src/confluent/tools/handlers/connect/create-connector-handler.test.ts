import { CreateConnectorHandler } from "@src/confluent/tools/handlers/connect/create-connector-handler.js";
import {
  bareRuntime,
  CCLOUD_CONN,
  ccloudOAuthRuntime,
  confluentCloudRuntime,
  CONNECT_CONN_WITH_AUTH,
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

type ConnectHandleCase = HandleCaseWithConn & {
  expectedEnvId?: string;
  expectedClusterId?: string;
  /** Response object the cloud REST POST resolves with. Use { data } for the
   *  success path or { error } for the API-error path. Omit for cases that
   *  throw before reaching the client. */
  mockResponse?: { data?: unknown; error?: unknown };
};

const MINIMAL_CONNECTOR_ARGS = {
  connectorName: "my-connector",
  connectorConfig: { "connector.class": "BigQuerySink" },
};

describe("create-connector-handler.ts", () => {
  describe("CreateConnectorHandler", () => {
    const handler = new CreateConnectorHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with confluent_cloud and kafka.auth", () => {
        expect(
          handler.enabledConnectionIds(runtimeWith(CONNECT_CONN_WITH_AUTH)),
        ).toEqual([DEFAULT_CONNECTION_ID]);
      });

      it("should return an empty array for a connection without a kafka block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });

      it("should return an empty array for a connection with confluent_cloud but no kafka.auth", () => {
        expect(handler.enabledConnectionIds(confluentCloudRuntime())).toEqual(
          [],
        );
      });

      it("should return an empty array for an OAuth-typed connection", () => {
        expect(handler.enabledConnectionIds(ccloudOAuthRuntime())).toEqual([]);
      });
    });

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
          runtime: runtimeWith(
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
    });
  });
});
