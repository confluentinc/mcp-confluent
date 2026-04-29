import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { CREATE_UPDATE } from "@src/confluent/tools/base-tools.js";
import { UpdateConnectorConfigHandler } from "@src/confluent/tools/handlers/connect/update-connector-config-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS } from "@src/env-schema.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it, type Mocked, vi } from "vitest";

describe("update-connector-config-handler.ts", () => {
  describe("UpdateConnectorConfigHandler", () => {
    const handler = new UpdateConnectorConfigHandler();
    let clientManager: Mocked<DefaultClientManager>;
    let restPut: ReturnType<typeof vi.fn>;

    const connectorConfig = {
      "connector.class": "S3_SINK",
      "tasks.max": "2",
      topics: "events",
    };

    const baseArgs = {
      environmentId: "env-1",
      clusterId: "lkc-1",
      connectorName: "my-connector",
      connectorConfig,
    };

    beforeEach(() => {
      restPut = vi.fn();
      clientManager = createMockInstance(DefaultClientManager);
      clientManager.getConfluentCloudRestClient.mockReturnValue({
        PUT: restPut,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });

    describe("getToolConfig()", () => {
      it("should return UPDATE_CONNECTOR_CONFIG with CREATE_UPDATE annotations", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.UPDATE_CONNECTOR_CONFIG);
        expect(config.annotations).toBe(CREATE_UPDATE);
      });
    });

    describe("getRequiredEnvVars()", () => {
      it("should return CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS", () => {
        expect(handler.getRequiredEnvVars()).toBe(
          CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS,
        );
      });
    });

    describe("isConfluentCloudOnly()", () => {
      it("should return true", () => {
        expect(handler.isConfluentCloudOnly()).toBe(true);
      });
    });

    describe("handle()", () => {
      it("should send the connector config map directly as the PUT body", async () => {
        const updated = { name: "my-connector", config: connectorConfig };
        restPut.mockResolvedValue({ data: updated, error: undefined });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBeFalsy();
        expect(restPut).toHaveBeenCalledOnce();
        const [path, init] = restPut.mock.calls[0]!;
        expect(path).toBe(
          "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}/config",
        );
        expect(init.params.path).toEqual({
          environment_id: "env-1",
          kafka_cluster_id: "lkc-1",
          connector_name: "my-connector",
        });
        // The flat config map must be the body, not wrapped in a {name, config} envelope.
        expect(init.body).toEqual(connectorConfig);

        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("my-connector");
        expect(text).toContain("config updated");
      });

      it("should return an error response when the REST call fails", async () => {
        const error = { error_code: 409, message: "conflict" };
        restPut.mockResolvedValue({ data: undefined, error });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Failed to update connector");
        expect(text).toContain(JSON.stringify(error));
      });
    });
  });
});
