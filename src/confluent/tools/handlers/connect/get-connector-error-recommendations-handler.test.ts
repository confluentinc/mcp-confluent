import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { GetConnectorErrorRecommendationsHandler } from "@src/confluent/tools/handlers/connect/get-connector-error-recommendations-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS } from "@src/env-schema.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it, type Mocked, vi } from "vitest";

describe("get-connector-error-recommendations-handler.ts", () => {
  describe("GetConnectorErrorRecommendationsHandler", () => {
    const handler = new GetConnectorErrorRecommendationsHandler();
    let clientManager: Mocked<DefaultClientManager>;
    let restGet: ReturnType<typeof vi.fn>;

    const baseArgs = {
      environmentId: "env-1",
      clusterId: "lkc-1",
      connectorName: "cypher-source",
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
      it("should return GET_CONNECTOR_ERROR_RECOMMENDATIONS with READ_ONLY annotations", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.GET_CONNECTOR_ERROR_RECOMMENDATIONS);
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
      it("should project the cypher-source fixture into recommendations", async () => {
        const recommendations = [
          "Verify that the 'database.user' and 'database.password' values in the connector configuration are correct and match the credentials for the PostgreSQL database.",
          "Ensure that the PostgreSQL server at 'database.hostname' (34.71.68.124) is accessible from Confluent Cloud and that the firewall or network settings allow connections on port 5432.",
          "Check that the PostgreSQL database 'test' exists and the user 'postgres' has the necessary permissions to access it, including the ability to read the database charset.",
        ];
        restGet.mockResolvedValue({
          data: {
            error: null,
            event_id: "lcc-oo0vvx_1777437507",
            recommendations,
          },
          error: undefined,
        });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBeFalsy();
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Error recommendations for cypher-source");
        const projection = JSON.parse(text.slice(text.indexOf("{")));
        expect(projection.connectorName).toBe("cypher-source");
        expect(projection.recommendations).toEqual(recommendations);
        expect(projection.eventId).toBe("lcc-oo0vvx_1777437507");
        expect(projection).not.toHaveProperty("engineError");
      });

      it("should return a one-liner when there are no recommendations and no engine error", async () => {
        restGet.mockResolvedValue({
          data: {
            error: null,
            event_id: "lcc-oo0vvx_1",
            recommendations: [],
          },
          error: undefined,
        });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBeFalsy();
        const text = (result.content[0] as { text: string }).text;
        expect(text).toBe(
          "No error recommendations available for connector cypher-source.",
        );
      });

      it("should surface engine errors as an error response", async () => {
        restGet.mockResolvedValue({
          data: {
            error: "recommendation engine throttled",
            event_id: "lcc-oo0vvx_2",
            recommendations: [],
          },
          error: undefined,
        });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Recommendation engine error");
        expect(text).toContain("throttled");
        expect(text).toContain("lcc-oo0vvx_2");
      });

      it("should return the friendly one-liner when Cloud returns 400 'no stack trace yet'", async () => {
        restGet.mockResolvedValue({
          data: undefined,
          error: {
            error: {
              code: 400,
              message:
                "could not generate recommendations as error stack trace is not available. Please retry when the connector is in a failed state.",
            },
          },
        });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBeFalsy();
        const text = (result.content[0] as { text: string }).text;
        expect(text).toBe(
          "No error recommendations available for connector cypher-source.",
        );
      });

      it("should return an error response when the REST call fails", async () => {
        const error = { error_code: 404, message: "missing" };
        restGet.mockResolvedValue({ data: undefined, error });

        const result = await handler.handle(clientManager, baseArgs);

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Failed to get error recommendations");
        expect(text).toContain(JSON.stringify(error));
      });
    });
  });
});
