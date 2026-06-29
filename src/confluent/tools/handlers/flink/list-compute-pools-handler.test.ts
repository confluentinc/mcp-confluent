import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { ListComputePoolsHandler } from "@src/confluent/tools/handlers/flink/list-compute-pools-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  CCLOUD_CONN,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  HandleCaseWithConn,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

type EnvIdCase = HandleCaseWithConn & {
  expectedEnvId: string;
};

/**
 * Shape the handler maps each validated FCPM compute pool down to, surfaced on
 * `result._meta.computePools`. Mirrors the projection in `handle()`.
 */
type MappedComputePool = {
  id: string;
  name: string;
  cloud: string;
  region: string;
};

/**
 * Builds an FCPM compute pool payload satisfying `computePoolSchema`. Only the
 * fields the regional Flink URL resolver consumes are pinned; everything else is
 * extra payload the handler ignores.
 */
function makeComputePool(): unknown {
  return {
    id: "lfcp-abc123",
    spec: {
      display_name: "prod-pool",
      cloud: "AWS",
      region: "us-east-1",
      max_cfu: 5,
    },
    status: { phase: "PROVISIONED" },
  };
}

describe("list-compute-pools-handler.ts", () => {
  describe("ListComputePoolsHandler", () => {
    const handler = new ListComputePoolsHandler();

    describe("getToolConfig()", () => {
      it("should be a read-only tool named LIST_COMPUTE_POOLS exposing only environmentId", () => {
        const config = handler.getToolConfig();

        expect(config.name).toBe(ToolName.LIST_COMPUTE_POOLS);
        expect(config.description).toBe(
          "Get all Flink compute pools in the Confluent Cloud environment",
        );
        expect(Object.keys(config.inputSchema)).toEqual(["environmentId"]);
        expect(config.annotations).toBe(READ_ONLY);
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
          outcome: { resolves: "Successfully retrieved 0 compute pools" },
          expectedEnvId: "env-from-config",
        },
        {
          label: "prefer explicit environmentId arg over conn kafka.env_id",
          connectionConfig: CCLOUD_WITH_KAFKA_CONN,
          args: { environmentId: "env-explicit" },
          outcome: { resolves: "Successfully retrieved 0 compute pools" },
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
            runtime: runtimeWithDecoy(
              connectionConfig,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientManager,
          });

          expect(cloudRest.GET).toHaveBeenCalledOnce();
          expect(cloudRest.GET).toHaveBeenCalledWith("/fcpm/v2/compute-pools", {
            params: {
              query: { environment: expectedEnvId, page_size: 100 },
            },
          });
        },
      );

      it("should throw a discovery hint under direct when neither environmentId arg nor conn kafka.env_id is present", async () => {
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
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

      it("should surface an error response carrying the API error when the GET returns one", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudRestClient()
          .GET.mockResolvedValue({ error: { message: "quota exceeded" } });

        const result = await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CCLOUD_WITH_KAFKA_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: {
            resolves:
              'Failed to fetch compute pools: {"message":"quota exceeded"}',
            isError: true,
          },
          clientManager,
        });

        expect(result?._meta).toEqual({ error: { message: "quota exceeded" } });
      });

      it.each([
        { label: "null", body: { data: null } },
        { label: "a non-object scalar", body: { data: 42 } },
      ])(
        "should reject when the response payload is $label",
        async ({ body }) => {
          const clientManager = getMockedClientManager();
          clientManager
            .getConfluentCloudRestClient()
            .GET.mockResolvedValue(body);

          await assertHandleCase({
            handler,
            runtime: runtimeWithDecoy(
              CCLOUD_WITH_KAFKA_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args: {},
            outcome: {
              resolves: "Invalid response format: response is not an object",
              isError: true,
            },
            clientManager,
          });
        },
      );

      it("should reject when the response data field is not an array", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudRestClient()
          .GET.mockResolvedValue({ data: { data: { not: "an array" } } });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CCLOUD_WITH_KAFKA_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: {
            resolves: "Invalid response format: missing or invalid data array",
            isError: true,
          },
          clientManager,
        });
      });

      it("should map a validated compute pool to the summarized shape and render its detail block", async () => {
        const clientManager = getMockedClientManager();
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: {
            data: [makeComputePool()],
            metadata: { total_size: 1 },
          },
        });

        const result = await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CCLOUD_WITH_KAFKA_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: {
            resolves: "Successfully retrieved 1 compute pools",
            isError: false,
          },
          clientManager,
        });

        const meta = result?._meta as {
          computePools: MappedComputePool[];
          total: number;
        };
        expect(meta.computePools).toEqual([
          {
            id: "lfcp-abc123",
            name: "prod-pool",
            cloud: "AWS",
            region: "us-east-1",
          },
        ]);
        expect(meta.total).toBe(1);

        const text = result!.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        expect(text).toContain("Compute Pool: prod-pool");
        expect(text).toContain("ID: lfcp-abc123");
      });

      it("should return an error response when a returned compute pool fails schema validation", async () => {
        const clientManager = getMockedClientManager();
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: { data: [{ id: "lfcp-malformed" }] },
        });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CCLOUD_WITH_KAFKA_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: {
            resolves:
              "Failed to fetch compute pools: Invalid compute pool data:",
            isError: true,
          },
          clientManager,
        });
      });
    });
  });
});
