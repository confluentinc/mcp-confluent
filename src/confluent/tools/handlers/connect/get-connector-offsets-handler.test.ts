import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { GetConnectorOffsetsHandler } from "@src/confluent/tools/handlers/connect/get-connector-offsets-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import type { ConnectHandleCase } from "@tests/factories/runtime.js";
import {
  CCLOUD_CONN,
  CONNECT_CONN,
  DEFAULT_CONNECTION_ID,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("get-connector-offsets-handler.ts", () => {
  describe("GetConnectorOffsetsHandler", () => {
    const handler = new GetConnectorOffsetsHandler();

    describe("getToolConfig()", () => {
      it("should return GET_CONNECTOR_OFFSETS with READ_ONLY annotations", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.GET_CONNECTOR_OFFSETS);
        expect(config.annotations).toBe(READ_ONLY);
      });
    });

    describe("handle()", () => {
      const cases: ConnectHandleCase[] = [
        {
          label: "return the connector offsets payload on success",
          connectionConfig: CONNECT_CONN,
          args: { connectorName: "my-connector" },
          mockResponse: {
            data: { offsets: [{ partition: { topic: "t" }, offset: 42 }] },
          },
          outcome: { resolves: "Connector Offsets for my-connector" },
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
          mockResponse: { data: { offsets: [] } },
          outcome: { resolves: "Connector Offsets for my-connector" },
          expectedEnvId: "env-from-arg",
          expectedClusterId: "lkc-from-arg",
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
          outcome: { resolves: "Failed to get offsets for connector" },
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
            runtime: runtimeWithDecoy(
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
              expect.stringContaining("/offsets"),
              expect.objectContaining({
                params: expect.objectContaining({
                  path: expect.objectContaining({
                    environment_id: expectedEnvId,
                    kafka_cluster_id: expectedClusterId,
                    connector_name: "my-connector",
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
