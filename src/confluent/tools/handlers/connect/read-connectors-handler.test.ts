import { ReadConnectorHandler } from "@src/confluent/tools/handlers/connect/read-connectors-handler.js";
import {
  bareRuntime,
  CCLOUD_CONN,
  ccloudOAuthRuntime,
  confluentCloudRuntime,
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const CONNECT_CONN = {
  ...CCLOUD_CONN,
  kafka: {
    env_id: "env-from-config",
    cluster_id: "lkc-from-config",
    rest_endpoint: "https://pkc-example.confluent.cloud:443",
  },
};

describe("read-connectors-handler.ts", () => {
  describe("ReadConnectorHandler", () => {
    const handler = new ReadConnectorHandler();

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
      const cases: HandleCaseWithConn[] = [
        {
          label:
            "fall back to conn kafka env_id and cluster_id when args are absent",
          connectionConfig: CONNECT_CONN,
          args: { connectorName: "my-connector" },
          responseData: { name: "my-connector", type: "SOURCE" },
          outcome: { resolves: "Connector Details for my-connector" },
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
          responseData: { name: "my-connector" },
          outcome: { resolves: "Connector Details for my-connector" },
        },
        {
          label: "throw when environment_id is absent from both arg and config",
          connectionConfig: CCLOUD_CONN,
          args: { connectorName: "my-connector" },
          responseData: {},
          outcome: { throws: "Environment ID is required" },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({ connectionConfig = {}, args, responseData, outcome }) => {
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
                  connector_name: "my-connector",
                }),
              }),
            });
          }
        },
      );
    });
  });
});
