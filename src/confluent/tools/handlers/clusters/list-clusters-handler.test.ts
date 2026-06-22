import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { ListClustersHandler } from "@src/confluent/tools/handlers/clusters/list-clusters-handler.js";
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
 * Shape the handler maps each validated CMK cluster down to, surfaced on
 * `result._meta.clusters`. Mirrors the projection in `handle()`.
 */
type MappedCluster = {
  id: string;
  name: string;
  availability: string;
  cloud: string;
  region: string;
  environmentId: string;
  status: string;
  cku: number;
  endpoints: { http: string; bootstrap: string };
  config: { kind: string; zones: string[] };
};

/**
 * Builds a CMK cluster payload satisfying `clusterSchema`. Overrides target the
 * fields whose mapping has branching logic (the `status.cku ?? config.cku ?? 0`
 * chain and the `zones ?? []` default); everything else is fixed boilerplate.
 */
function makeCluster(overrides?: {
  statusCku?: number;
  configCku?: number;
  zones?: string[];
}): unknown {
  return {
    api_version: "cmk/v2",
    id: "lkc-abc123",
    kind: "Cluster",
    metadata: {
      created_at: "2024-01-01T00:00:00Z",
      resource_name: "crn://cluster",
      self: "https://api.confluent.cloud/cmk/v2/clusters/lkc-abc123",
      updated_at: "2024-01-02T00:00:00Z",
    },
    spec: {
      api_endpoint: "https://pkac-xxxxx.us-east-1.aws.confluent.cloud",
      availability: "SINGLE_ZONE",
      cloud: "AWS",
      config: {
        kind: "Dedicated",
        cku: overrides?.configCku,
        zones: overrides?.zones,
      },
      display_name: "prod-cluster",
      environment: {
        id: "env-xyz",
        related: "https://api.confluent.cloud/org/v2/environments/env-xyz",
        resource_name: "crn://environment",
      },
      http_endpoint: "https://pkc-xxxxx.us-east-1.aws.confluent.cloud:443",
      kafka_bootstrap_endpoint:
        "SASL_SSL://pkc-xxxxx.us-east-1.aws.confluent.cloud:9092",
      region: "us-east-1",
    },
    status: {
      phase: "PROVISIONED",
      cku: overrides?.statusCku,
    },
  };
}

describe("list-clusters-handler.ts", () => {
  describe("ListClustersHandler", () => {
    const handler = new ListClustersHandler();

    describe("getToolConfig()", () => {
      it("should be a read-only tool named LIST_CLUSTERS exposing only environmentId", () => {
        const config = handler.getToolConfig();

        expect(config.name).toBe(ToolName.LIST_CLUSTERS);
        expect(config.description).toBe(
          "Get all clusters in the Confluent Cloud environment",
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
            resolves: 'Failed to fetch clusters: {"message":"quota exceeded"}',
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

      it("should map a validated cluster to the summarized shape and render its detail block", async () => {
        const clientManager = getMockedClientManager();
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: {
            data: [
              makeCluster({ statusCku: 3, zones: ["use1-az1", "use1-az2"] }),
            ],
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
            resolves: "Successfully retrieved 1 clusters",
            isError: false,
          },
          clientManager,
        });

        const meta = result?._meta as {
          clusters: MappedCluster[];
          total: number;
        };
        expect(meta.clusters).toEqual([
          {
            id: "lkc-abc123",
            name: "prod-cluster",
            availability: "SINGLE_ZONE",
            cloud: "AWS",
            region: "us-east-1",
            environmentId: "env-xyz",
            status: "PROVISIONED",
            cku: 3,
            endpoints: {
              http: "https://pkc-xxxxx.us-east-1.aws.confluent.cloud:443",
              bootstrap:
                "SASL_SSL://pkc-xxxxx.us-east-1.aws.confluent.cloud:9092",
            },
            config: { kind: "Dedicated", zones: ["use1-az1", "use1-az2"] },
          },
        ]);
        expect(meta.total).toBe(1);

        const text = result!.content
          .map((c) => ("text" in c ? c.text : ""))
          .join("");
        expect(text).toContain("Cluster: prod-cluster");
        expect(text).toContain("Zones: use1-az1, use1-az2");
      });

      it.each([
        {
          label: "status.cku when present (winning over config.cku)",
          overrides: { statusCku: 3, configCku: 5, zones: ["z1"] },
          expectedCku: 3,
          expectedZones: ["z1"],
        },
        {
          label: "config.cku when status.cku is absent",
          overrides: { configCku: 5 },
          expectedCku: 5,
          expectedZones: [],
        },
        {
          label: "0 when neither cku is present, defaulting zones to empty",
          overrides: {},
          expectedCku: 0,
          expectedZones: [],
        },
      ])(
        "should resolve cku to $label",
        async ({ overrides, expectedCku, expectedZones }) => {
          const clientManager = getMockedClientManager();
          clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
            data: { data: [makeCluster(overrides)] },
          });

          const result = await assertHandleCase({
            handler,
            runtime: runtimeWithDecoy(
              CCLOUD_WITH_KAFKA_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args: {},
            outcome: { resolves: "Successfully retrieved 1 clusters" },
            clientManager,
          });

          const meta = result?._meta as { clusters: MappedCluster[] };
          expect(meta.clusters).toHaveLength(1);
          const cluster = meta.clusters[0]!;
          expect(cluster.cku).toBe(expectedCku);
          expect(cluster.config.zones).toEqual(expectedZones);
        },
      );

      it("should return an error response when a returned cluster fails schema validation", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudRestClient()
          .GET.mockResolvedValue({ data: { data: [{ id: "lkc-malformed" }] } });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CCLOUD_WITH_KAFKA_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: {
            resolves: "Failed to fetch clusters: Invalid cluster data:",
            isError: true,
          },
          clientManager,
        });
      });
    });
  });
});
