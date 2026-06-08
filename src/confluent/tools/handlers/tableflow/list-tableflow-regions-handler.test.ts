import { ListTableFlowRegionsHandler } from "@src/confluent/tools/handlers/tableflow/list-tableflow-regions-handler.js";
import {
  DEFAULT_CONNECTION_ID,
  runtimeWithDecoy,
  TABLEFLOW_CONN,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  type MockedRestClient,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

describe("list-tableflow-regions-handler.ts", () => {
  describe("ListTableFlowRegionsHandler", () => {
    const handler = new ListTableFlowRegionsHandler();

    describe("handle()", () => {
      it("should resolve with a regions list on success", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudTableflowRestClient()
          .GET.mockResolvedValue({ data: [] });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            TABLEFLOW_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { cloud: "AWS" },
          outcome: { resolves: "Tableflow Regions" },
          clientManager,
        });
      });

      it("should resolve with an error message when the API returns an error", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudTableflowRestClient()
          .GET.mockResolvedValue({ error: { message: "unauthorized" } });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            TABLEFLOW_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { cloud: "AWS" },
          outcome: { resolves: "Failed to list Tableflow regions:" },
          clientManager,
        });
      });

      it("should send cloud as a query parameter when provided", async () => {
        const clientManager = getMockedClientManager();
        const tableflowRest: MockedRestClient =
          clientManager.getConfluentCloudTableflowRestClient();
        tableflowRest.GET.mockResolvedValue({ data: [] });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            TABLEFLOW_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { cloud: "AWS" },
          outcome: { resolves: "Tableflow Regions" },
          clientManager,
        });

        expect(tableflowRest.GET).toHaveBeenCalledOnce();
        expect(tableflowRest.GET).toHaveBeenCalledWith(
          "/tableflow/v1/regions",
          {
            params: {
              query: {
                cloud: "AWS",
                page_size: undefined,
                page_token: undefined,
              },
            },
          },
        );
      });

      it("should not encode cloud in the request path when omitted", async () => {
        const clientManager = getMockedClientManager();
        const tableflowRest: MockedRestClient =
          clientManager.getConfluentCloudTableflowRestClient();
        tableflowRest.GET.mockResolvedValue({ data: [] });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            TABLEFLOW_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: { resolves: "Tableflow Regions" },
          clientManager,
        });

        // regression for #129: an omitted `cloud` must not be encoded into the
        // path key as `?cloud=undefined`, and must not regress to `params.path`
        expect(tableflowRest.GET).toHaveBeenCalledOnce();
        expect(tableflowRest.GET).toHaveBeenCalledWith(
          "/tableflow/v1/regions",
          {
            params: {
              query: {
                cloud: undefined,
                page_size: undefined,
                page_token: undefined,
              },
            },
          },
        );
      });

      it("should send pagination as snake_case query parameters", async () => {
        const clientManager = getMockedClientManager();
        const tableflowRest: MockedRestClient =
          clientManager.getConfluentCloudTableflowRestClient();
        tableflowRest.GET.mockResolvedValue({ data: [] });

        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            TABLEFLOW_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { pageSize: 20, pageToken: "abc" },
          outcome: { resolves: "Tableflow Regions" },
          clientManager,
        });

        expect(tableflowRest.GET).toHaveBeenCalledOnce();
        expect(tableflowRest.GET).toHaveBeenCalledWith(
          "/tableflow/v1/regions",
          {
            params: {
              query: {
                cloud: undefined,
                page_size: 20,
                page_token: "abc",
              },
            },
          },
        );
      });
    });
  });
});
