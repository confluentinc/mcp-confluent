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
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

type ConnectHandleCase = HandleCaseWithConn & {
  expectedEnvId?: string;
  expectedClusterId?: string;
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
          responseData: { name: "my-connector" },
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
          responseData: { name: "my-connector" },
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
          responseData: {},
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
          responseData: {},
          outcome: { throws: "Kafka Cluster ID is required" },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({
          connectionConfig = {},
          args,
          responseData,
          outcome,
          expectedEnvId,
          expectedClusterId,
        }) => {
          const { clientManager, clientGetters, capturedCalls } =
            stubClientGetters(responseData);
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              connectionConfig,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientGetters,
          });
          if (typeof outcome === "object" && "resolves" in outcome) {
            expect(capturedCalls).toHaveLength(1);
            expect(capturedCalls[0]!.args).toMatchObject({
              params: expect.objectContaining({
                path: expect.objectContaining({
                  environment_id: expectedEnvId,
                  kafka_cluster_id: expectedClusterId,
                }),
              }),
            });
          }
        },
      );

      it("should embed kafka auth credentials from conn config in the POST body", async () => {
        const { clientManager, capturedCalls } = stubClientGetters({
          name: "my-connector",
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            CONNECT_CONN_WITH_AUTH,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: MINIMAL_CONNECTOR_ARGS,
          outcome: { resolves: "my-connector created" },
        });
        expect(capturedCalls[0]!.args).toMatchObject({
          body: expect.objectContaining({
            config: expect.objectContaining({
              "kafka.api.key": "kafka-key",
              "kafka.api.secret": "kafka-secret",
            }),
          }),
        });
      });
    });
  });
});
