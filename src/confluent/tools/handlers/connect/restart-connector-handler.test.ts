import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { CREATE_UPDATE } from "@src/confluent/tools/base-tools.js";
import { RestartConnectorHandler } from "@src/confluent/tools/handlers/connect/restart-connector-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS } from "@src/env-schema.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it, type Mocked, vi } from "vitest";

describe("restart-connector-handler.ts", () => {
  describe("RestartConnectorHandler", () => {
    const handler = new RestartConnectorHandler();
    let clientManager: Mocked<DefaultClientManager>;
    let restPost: ReturnType<typeof vi.fn>;

    const baseArgs = {
      environmentId: "env-1",
      clusterId: "lkc-1",
      connectorName: "my-connector",
    };

    beforeEach(() => {
      restPost = vi.fn();
      clientManager = createMockInstance(DefaultClientManager);
      clientManager.getConfluentCloudRestClient.mockReturnValue({
        POST: restPost,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });

    describe("getToolConfig()", () => {
      it("should return RESTART_CONNECTOR with CREATE_UPDATE annotations", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.RESTART_CONNECTOR);
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
      it("should issue a POST to the restart path with no query when no flags are set", async () => {
        restPost.mockResolvedValue({ data: undefined, error: undefined });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBeFalsy();
        expect(restPost).toHaveBeenCalledOnce();
        const [path, init] = restPost.mock.calls[0]!;
        expect(path).toBe(
          "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}/restart",
        );
        expect(init.params.path).toEqual({
          environment_id: "env-1",
          kafka_cluster_id: "lkc-1",
          connector_name: "my-connector",
        });
        expect(init.params.query).toBeUndefined();

        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Restart requested");
        expect(text).toContain("my-connector");
      });

      it("should forward includeTasks and onlyFailed as query params when provided", async () => {
        restPost.mockResolvedValue({ data: undefined, error: undefined });

        await handler.handle(clientManager, {
          ...baseArgs,
          includeTasks: true,
          onlyFailed: true,
        });

        expect(restPost).toHaveBeenCalledOnce();
        const [, init] = restPost.mock.calls[0]!;
        expect(init.params.query).toEqual({
          includeTasks: true,
          onlyFailed: true,
        });
      });

      it("should return an error response when the REST call fails", async () => {
        const error = { error_code: 500, message: "boom" };
        restPost.mockResolvedValue({ data: undefined, error });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Failed to restart connector");
        expect(text).toContain(JSON.stringify(error));
      });
    });
  });
});
