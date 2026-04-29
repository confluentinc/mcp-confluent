import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { GetConnectorStatusHandler } from "@src/confluent/tools/handlers/connect/get-connector-status-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS } from "@src/env-schema.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it, type Mocked, vi } from "vitest";

describe("get-connector-status-handler.ts", () => {
  describe("GetConnectorStatusHandler", () => {
    const handler = new GetConnectorStatusHandler();
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
      it("should return GET_CONNECTOR_STATUS with READ_ONLY annotations", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.GET_CONNECTOR_STATUS);
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
      it("should return the connector status payload on success", async () => {
        const payload = {
          name: "my-connector",
          connector: { state: "RUNNING" },
          tasks: [{ id: 0, state: "RUNNING" }],
        };
        restGet.mockResolvedValue({ data: payload, error: undefined });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBeFalsy();
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("my-connector");
        // Without an `id` block in the response, projection equals the payload.
        expect(text).toContain(JSON.stringify(payload));
      });

      it("should pass expand=id as a query param", async () => {
        restGet.mockResolvedValue({
          data: { name: "my-connector", connector: { state: "RUNNING" } },
          error: undefined,
        });

        await handler.handle(clientManager, baseArgs);

        // openapi-fetch's wrapped GET signature is (path, init).
        const init = restGet.mock.calls[0]![1] as {
          params: { query?: { expand?: string } };
        };
        expect(init.params.query?.expand).toBe("id");
      });

      it("should surface lccId when the response includes an id expansion", async () => {
        restGet.mockResolvedValue({
          data: {
            name: "my-connector",
            connector: { state: "RUNNING" },
            tasks: [],
            id: { id: "lcc-abc123", id_type: "ID" },
          },
          error: undefined,
        });

        const result = await handler.handle(clientManager, baseArgs);

        const text = (result.content[0] as { text: string }).text;
        const projection = JSON.parse(text.slice(text.indexOf("{")));
        expect(projection.lccId).toBe("lcc-abc123");
        expect(projection.id).toEqual({ id: "lcc-abc123", id_type: "ID" });
      });

      it("should return an error response when the REST call fails", async () => {
        const error = { error_code: 404, message: "missing" };
        restGet.mockResolvedValue({ data: undefined, error });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Failed to get status");
        expect(text).toContain(JSON.stringify(error));
      });
    });
  });
});
