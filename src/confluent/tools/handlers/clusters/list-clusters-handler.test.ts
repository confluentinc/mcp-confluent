import { ListClustersHandler } from "@src/confluent/tools/handlers/clusters/list-clusters-handler.js";
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

type EnvIdCase = HandleCaseWithConn & {
  expectedEnvId: string;
};

describe("list-clusters-handler.ts", () => {
  describe("ListClustersHandler", () => {
    const handler = new ListClustersHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with a confluent_cloud block", () => {
        expect(handler.enabledConnectionIds(confluentCloudRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a confluent_cloud block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });

      it("should return the connection id when the connection is OAuth-typed", () => {
        expect(handler.enabledConnectionIds(ccloudOAuthRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });
    });

    describe("handle()", () => {
      const CCLOUD_WITH_KAFKA_CONN = {
        ...CCLOUD_CONN,
        kafka: {
          env_id: "env-from-config",
          rest_endpoint: "https://pkc-xxxxx.us-east-1.aws.confluent.cloud:443",
        },
      };

      const cases: EnvIdCase[] = [
        {
          label:
            "fall back to conn kafka.env_id when environmentId arg is absent",
          connectionConfig: CCLOUD_WITH_KAFKA_CONN,
          args: {},
          responseData: { data: [] },
          outcome: { resolves: "Successfully retrieved 0 clusters" },
          expectedEnvId: "env-from-config",
        },
        {
          label: "prefer explicit environmentId arg over conn kafka.env_id",
          connectionConfig: CCLOUD_WITH_KAFKA_CONN,
          args: { environmentId: "env-explicit" },
          responseData: { data: [] },
          outcome: { resolves: "Successfully retrieved 0 clusters" },
          expectedEnvId: "env-explicit",
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
          expect(capturedCalls).toHaveLength(1);
          expect(capturedCalls[0]!.args).toMatchObject({
            params: expect.objectContaining({
              query: expect.objectContaining({ environment: expectedEnvId }),
            }),
          });
        },
      );

      it("should return an error response when both environmentId arg and conn kafka.env_id are absent (direct)", async () => {
        const { clientManager } = stubClientGetters({});
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            CCLOUD_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: { resolves: "environmentId is required" },
        });
      });
    });
  });
});
