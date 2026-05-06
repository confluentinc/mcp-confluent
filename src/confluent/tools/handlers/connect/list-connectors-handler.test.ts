import { ListConnectorsHandler } from "@src/confluent/tools/handlers/connect/list-connectors-handler.js";
import {
  bareRuntime,
  CCLOUD_CONN,
  ccloudOAuthRuntime,
  confluentCloudRuntime,
  CONNECT_CONN,
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
  /** Response object the cloud REST GET resolves with. Use { data } for the
   *  success path or { error } for the API-error path. Omit for cases that
   *  throw before reaching the client. */
  mockResponse?: { data?: unknown; error?: unknown };
};

describe("list-connectors-handler.ts", () => {
  describe("ListConnectorsHandler", () => {
    const handler = new ListConnectorsHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with a confluent_cloud block", () => {
        expect(handler.enabledConnectionIds(confluentCloudRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a confluent_cloud block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
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
          connectionConfig: CONNECT_CONN,
          args: {},
          mockResponse: { data: ["connector-a", "connector-b"] },
          outcome: { resolves: "Active Connectors" },
          expectedEnvId: "env-from-config",
          expectedClusterId: "lkc-from-config",
        },
        {
          label:
            "prefer explicit environmentId and clusterId args over conn config",
          connectionConfig: CONNECT_CONN,
          args: { environmentId: "env-from-arg", clusterId: "lkc-from-arg" },
          mockResponse: { data: ["connector-a"] },
          outcome: { resolves: "Active Connectors" },
          expectedEnvId: "env-from-arg",
          expectedClusterId: "lkc-from-arg",
        },
        {
          label: "throw when environment_id is absent from both arg and config",
          connectionConfig: CCLOUD_CONN,
          args: {},
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
          args: {},
          outcome: { throws: "Kafka Cluster ID is required" },
        },
        {
          label: "resolve with an error message when the API returns an error",
          connectionConfig: CONNECT_CONN,
          args: {},
          mockResponse: { error: { message: "unauthorized" } },
          outcome: { resolves: "Failed to list Confluent Cloud connectors" },
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
            cloudRest.GET.mockResolvedValue(mockResponse);
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
            expect(cloudRest.GET).toHaveBeenCalledOnce();
            expect(cloudRest.GET).toHaveBeenCalledWith(
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
    });
  });
});
