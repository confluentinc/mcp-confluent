import { ListConnectorsHandler } from "@src/confluent/tools/handlers/connect/list-connectors-handler.js";
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
      const cases: HandleCaseWithConn[] = [
        {
          label:
            "fall back to conn kafka env_id and cluster_id when args are absent",
          connectionConfig: CONNECT_CONN,
          args: {},
          responseData: [["connector-a", "connector-b"]],
          outcome: { resolves: "Active Connectors" },
        },
        {
          label:
            "prefer explicit environmentId and clusterId args over conn config",
          connectionConfig: CONNECT_CONN,
          args: { environmentId: "env-from-arg", clusterId: "lkc-from-arg" },
          responseData: [["connector-a"]],
          outcome: { resolves: "Active Connectors" },
        },
        {
          label: "throw when environment_id is absent from both arg and config",
          connectionConfig: CCLOUD_CONN,
          args: {},
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
          }
        },
      );

      it("should route the request with the resolved environment_id and kafka_cluster_id", async () => {
        const { clientManager, capturedCalls } = stubClientGetters([[]]);
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            CONNECT_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { environmentId: "env-explicit", clusterId: "lkc-explicit" },
          outcome: { resolves: "Active Connectors" },
        });
        expect(capturedCalls[0]!.args).toMatchObject({
          params: expect.objectContaining({
            path: expect.objectContaining({
              environment_id: "env-explicit",
              kafka_cluster_id: "lkc-explicit",
            }),
          }),
        });
      });
    });
  });
});
