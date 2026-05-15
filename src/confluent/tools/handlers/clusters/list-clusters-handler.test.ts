import { ListClustersHandler } from "@src/confluent/tools/handlers/clusters/list-clusters-handler.js";
import {
  CCLOUD_CONN,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

type EnvIdCase = HandleCaseWithConn & {
  expectedEnvId: string;
};

describe("list-clusters-handler.ts", () => {
  describe("ListClustersHandler", () => {
    const handler = new ListClustersHandler();

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
          outcome: { resolves: "Successfully retrieved 0 clusters" },
          expectedEnvId: "env-from-config",
        },
        {
          label: "prefer explicit environmentId arg over conn kafka.env_id",
          connectionConfig: CCLOUD_WITH_KAFKA_CONN,
          args: { environmentId: "env-explicit" },
          outcome: { resolves: "Successfully retrieved 0 clusters" },
          expectedEnvId: "env-explicit",
        },
      ];

      it.each(cases)(
        "should $label",
        async ({ connectionConfig = {}, args, outcome, expectedEnvId }) => {
          const clientManager = getMockedClientManager();
          const cloudRest = clientManager.getConfluentCloudRestClient();
          cloudRest.GET.mockResolvedValue({ data: { data: [] } });

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

          expect(cloudRest.GET).toHaveBeenCalledOnce();
          expect(cloudRest.GET).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({
              params: expect.objectContaining({
                query: expect.objectContaining({ environment: expectedEnvId }),
              }),
            }),
          );
        },
      );

      it("should throw a discovery hint under direct when neither environmentId arg nor conn kafka.env_id is present", async () => {
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            CCLOUD_CONN,
            DEFAULT_CONNECTION_ID,
            getMockedClientManager(),
          ),
          args: {},
          outcome: { throws: "set kafka.env_id in the connection config" },
        });
      });

      it("should throw a discovery hint under OAuth when environmentId is omitted", async () => {
        await assertHandleCase({
          handler,
          runtime: ccloudOAuthRuntime(),
          args: {},
          outcome: { throws: "call list-environments" },
        });
      });
    });
  });
});
