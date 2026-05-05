import { ListTableFlowRegionsHandler } from "@src/confluent/tools/handlers/tableflow/list-tableflow-regions-handler.js";
import {
  bareRuntime,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
  tableflowRuntime,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
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
        const { clientManager, clientGetters } = stubClientGetters({
          data: [],
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: { cloud: "AWS" },
          outcome: { resolves: "Tableflow Regions" },
          clientGetters,
        });
      });

      it("should resolve with an error message when the API returns an error", async () => {
        const { clientManager } = stubClientGetters({
          error: { message: "unauthorized" },
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: { cloud: "AWS" },
          outcome: { resolves: "Failed to list Tableflow regions for  AWS" },
        });
      });

      it("should pass the cloud filter in the request path", async () => {
        const { clientManager, capturedCalls } = stubClientGetters({
          data: [],
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: { cloud: "AWS" },
          outcome: { resolves: "Tableflow Regions" },
        });
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]!.args).toMatchObject({
          params: expect.objectContaining({
            path: expect.objectContaining({ cloud: "AWS" }),
          }),
        });
      });
    });
  });
});
