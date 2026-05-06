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
        {
          label:
            "use empty string when both environmentId arg and conn kafka.env_id are absent",
          connectionConfig: CCLOUD_CONN,
          args: {},
          outcome: { resolves: "Successfully retrieved 0 clusters" },
          expectedEnvId: "",
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
    });
  });
});
