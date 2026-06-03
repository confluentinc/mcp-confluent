import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { GetConnectorErrorRecommendationsHandler } from "@src/confluent/tools/handlers/connect/get-connector-error-recommendations-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  CONNECT_CONN,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  getMockedClientManager,
  type MockedClientManager,
} from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it } from "vitest";

describe("get-connector-error-recommendations-handler.ts", () => {
  describe("GetConnectorErrorRecommendationsHandler", () => {
    const handler = new GetConnectorErrorRecommendationsHandler();
    let clientManager: MockedClientManager;

    const baseArgs = {
      environmentId: "env-1",
      clusterId: "lkc-1",
      connectorName: "cypher-source",
    };

    beforeEach(() => {
      clientManager = getMockedClientManager();
    });

    function callHandle(args: Record<string, unknown> = baseArgs) {
      const runtime = runtimeWith(
        CONNECT_CONN,
        DEFAULT_CONNECTION_ID,
        clientManager,
      );
      return handler.handle(runtime, args);
    }

    describe("getToolConfig()", () => {
      it("should return GET_CONNECTOR_ERROR_RECOMMENDATIONS with READ_ONLY annotations", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.GET_CONNECTOR_ERROR_RECOMMENDATIONS);
        expect(config.annotations).toBe(READ_ONLY);
      });
    });

    describe("handle()", () => {
      it("should project the cypher-source fixture into recommendations", async () => {
        const recommendations = [
          "Verify that the 'database.user' and 'database.password' values in the connector configuration are correct and match the credentials for the PostgreSQL database.",
          "Ensure that the PostgreSQL server at 'database.hostname' (34.71.68.124) is accessible from Confluent Cloud and that the firewall or network settings allow connections on port 5432.",
          "Check that the PostgreSQL database 'test' exists and the user 'postgres' has the necessary permissions to access it, including the ability to read the database charset.",
        ];
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: {
            error: null,
            event_id: "lcc-oo0vvx_1777437507",
            recommendations,
          },
        });

        const result = await callHandle();

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
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: {
            error: null,
            event_id: "lcc-oo0vvx_1",
            recommendations: [],
          },
        });

        const result = await callHandle();

        expect(result.isError).toBeFalsy();
        const text = (result.content[0] as { text: string }).text;
        expect(text).toBe(
          "No error recommendations available for connector cypher-source.",
        );
      });

      it("should surface engine errors as an error response", async () => {
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: {
            error: "recommendation engine throttled",
            event_id: "lcc-oo0vvx_2",
            recommendations: [],
          },
        });

        const result = await callHandle();

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Recommendation engine error");
        expect(text).toContain("throttled");
        expect(text).toContain("lcc-oo0vvx_2");
      });

      it("should return the friendly one-liner when Cloud returns 400 'no stack trace yet'", async () => {
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          error: {
            error: {
              code: 400,
              message:
                "could not generate recommendations as error stack trace is not available. Please retry when the connector is in a failed state.",
            },
          },
        });

        const result = await callHandle();

        expect(result.isError).toBeFalsy();
        const text = (result.content[0] as { text: string }).text;
        expect(text).toBe(
          "No error recommendations available for connector cypher-source.",
        );
      });

      it("should return an error response when the REST call fails", async () => {
        const error = { error_code: 404, message: "missing" };
        clientManager
          .getConfluentCloudRestClient()
          .GET.mockResolvedValue({ error });

        const result = await callHandle();

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Failed to get error recommendations");
        expect(text).toContain(JSON.stringify(error));
      });
    });
  });
});
