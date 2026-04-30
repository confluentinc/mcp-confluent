import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { GetConnectorConfigHandler } from "@src/confluent/tools/handlers/connect/get-connector-config-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS } from "@src/env-schema.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it, type Mocked, vi } from "vitest";

describe("get-connector-config-handler.ts", () => {
  describe("GetConnectorConfigHandler", () => {
    const handler = new GetConnectorConfigHandler();
    let clientManager: Mocked<DefaultClientManager>;
    let restGet: ReturnType<typeof vi.fn>;

    const baseArgs = {
      environmentId: "env-1",
      clusterId: "lkc-1",
      connectorName: "my-connector",
    };

    beforeEach(() => {
      restGet = vi.fn();
      clientManager = createMockInstance(DefaultClientManager);
      clientManager.getConfluentCloudRestClient.mockReturnValue({
        GET: restGet,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });

    describe("getToolConfig()", () => {
      it("should return GET_CONNECTOR_CONFIG with READ_ONLY annotations", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.GET_CONNECTOR_CONFIG);
        expect(config.annotations).toBe(READ_ONLY);
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
      it("should return the connector config payload on success", async () => {
        const payload = { "connector.class": "S3_SINK", tasks: "1" };
        restGet.mockResolvedValue({ data: payload, error: undefined });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBeFalsy();
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("my-connector");
        expect(text).toContain(JSON.stringify(payload));
      });

      it("should return an error response when the REST call fails", async () => {
        const error = { error_code: 404, message: "not found" };
        restGet.mockResolvedValue({ data: undefined, error });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Failed to get config");
        expect(text).toContain(JSON.stringify(error));
      });
    });
  });
});
