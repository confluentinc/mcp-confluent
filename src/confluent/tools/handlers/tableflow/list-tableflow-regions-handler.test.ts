import { ListTableFlowRegionsHandler } from "@src/confluent/tools/handlers/tableflow/list-tableflow-regions-handler.js";
import {
  bareRuntime,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
  tableflowRuntime,
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

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with a tableflow block", () => {
        expect(handler.enabledConnectionIds(tableflowRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a tableflow block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });

      it("should return an empty array for an OAuth-typed connection", () => {
        expect(handler.enabledConnectionIds(ccloudOAuthRuntime())).toEqual([]);
      });
    });

    describe("handle()", () => {
      it("should resolve with a regions list on success", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudTableflowRestClient()
          .GET.mockResolvedValue({ data: [] });
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
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
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: { cloud: "AWS" },
          outcome: { resolves: "Failed to list Tableflow regions for  AWS" },
          clientManager,
        });
      });

      it("should pass the cloud filter in the request path", async () => {
        const clientManager = getMockedClientManager();
        const tableflowRest: MockedRestClient =
          clientManager.getConfluentCloudTableflowRestClient();
        tableflowRest.GET.mockResolvedValue({ data: [] });
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: { cloud: "AWS" },
          outcome: { resolves: "Tableflow Regions" },
          clientManager,
        });
        expect(tableflowRest.GET).toHaveBeenCalledOnce();
        expect(tableflowRest.GET).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            params: expect.objectContaining({
              path: expect.objectContaining({ cloud: "AWS" }),
            }),
          }),
        );
      });
    });
  });
});
