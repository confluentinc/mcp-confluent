import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { GetConnectorStatusHandler } from "@src/confluent/tools/handlers/connect/get-connector-status-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  CCLOUD_CONN,
  CONNECT_CONN,
  ConnectHandleCase,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("get-connector-status-handler.ts", () => {
  describe("GetConnectorStatusHandler", () => {
    const handler = new GetConnectorStatusHandler();

    describe("getToolConfig()", () => {
      it("should return GET_CONNECTOR_STATUS with READ_ONLY annotations", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.GET_CONNECTOR_STATUS);
        expect(config.annotations).toBe(READ_ONLY);
      });
    });

    describe("handle()", () => {
      const cases: ConnectHandleCase[] = [
        {
          label:
            "surface lccId at the top level when the expansion map entry includes an `id` block",
          connectionConfig: CONNECT_CONN,
          args: { connectorName: "my-connector" },
          mockResponse: {
            data: {
              "my-connector": {
                status: {
                  name: "my-connector",
                  connector: { state: "RUNNING" },
                },
                id: { id: "lcc-abc123", id_type: "ID" },
              },
            },
          },
          outcome: { resolves: '"lccId":"lcc-abc123"' },
          expectedEnvId: "env-from-config",
          expectedClusterId: "lkc-from-config",
        },
        {
          label: "omit lccId when the expansion map entry has no `id` block",
          connectionConfig: CONNECT_CONN,
          args: { connectorName: "my-connector" },
          mockResponse: {
            data: {
              "my-connector": {
                status: {
                  name: "my-connector",
                  connector: { state: "RUNNING" },
                },
              },
            },
          },
          outcome: { resolves: "Connector Status for my-connector" },
          expectedEnvId: "env-from-config",
          expectedClusterId: "lkc-from-config",
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
          mockResponse: {
            data: {
              "my-connector": { status: { name: "my-connector" } },
            },
          },
          outcome: { resolves: "Connector Status for my-connector" },
          expectedEnvId: "env-from-arg",
          expectedClusterId: "lkc-from-arg",
        },
        {
          label:
            "return a not-found error when the expansion map omits the requested connector",
          connectionConfig: CONNECT_CONN,
          args: { connectorName: "my-connector" },
          mockResponse: { data: {} },
          outcome: { resolves: "Connector my-connector not found" },
          expectedEnvId: "env-from-config",
          expectedClusterId: "lkc-from-config",
        },
        {
          label: "throw ZodError when connectorName is missing",
          connectionConfig: CONNECT_CONN,
          args: {},
          outcome: { throws: "ZodError" },
        },
        {
          label: "throw when environment_id is absent from both arg and config",
          connectionConfig: CCLOUD_CONN,
          args: { connectorName: "my-connector" },
          outcome: { throws: "Environment ID is required" },
        },
        {
          label: "resolve with an error message when the API returns an error",
          connectionConfig: CONNECT_CONN,
          args: { connectorName: "my-connector" },
          mockResponse: { error: { message: "unauthorized" } },
          outcome: { resolves: "Failed to get status for connector" },
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
              expect.stringContaining("?expand=info,status,id"),
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
