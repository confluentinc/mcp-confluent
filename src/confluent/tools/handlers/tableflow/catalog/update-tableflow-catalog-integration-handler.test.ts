import { UpdateTableFlowCatalogIntegrationHandler } from "@src/confluent/tools/handlers/tableflow/catalog/update-tableflow-catalog-integration-handler.js";
import {
  bareRuntime,
  ccloudOAuthRuntime,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
  tableflowRuntime,
} from "@tests/factories/runtime.js";
import { assertHandleCase, stubClientGetters } from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const UPDATE_ARGS = {
  tableflowCatalogIntegrationConfig: {
    display_name: "my-catalog",
    environment: { id: "env-abc123" },
    kafka_cluster: { id: "lkc-abc123", environment: "env-abc123" },
    config: { kind: "AwsGlue" },
  },
};

describe("update-tableflow-catalog-integration-handler.ts", () => {
  describe("UpdateTableFlowCatalogIntegrationHandler", () => {
    const handler = new UpdateTableFlowCatalogIntegrationHandler();

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
      it("should resolve with an updated message on success", async () => {
        const { clientManager, clientGetters } = stubClientGetters({
          display_name: "my-catalog",
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: UPDATE_ARGS,
          outcome: {
            resolves: "Tableflow Catalog Integration my-catalog updated",
          },
          clientGetters,
        });
      });

      it("should resolve with an error message when the API returns an error", async () => {
        const { clientManager } = stubClientGetters({
          error: { message: "not found" },
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: UPDATE_ARGS,
          outcome: {
            resolves:
              "Failed to update Tableflow Catalog Integration for  my-catalog",
          },
        });
      });

      it("should pass only environment.id in the POST body spec, not the full environment object", async () => {
        const { clientManager, capturedCalls } = stubClientGetters({
          display_name: "my-catalog",
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWith({}, DEFAULT_CONNECTION_ID, clientManager),
          args: UPDATE_ARGS,
          outcome: {
            resolves: "Tableflow Catalog Integration my-catalog updated",
          },
        });
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]!.args).toMatchObject({
          body: expect.objectContaining({
            spec: expect.objectContaining({
              environment: { id: "env-abc123" },
              kafka_cluster: expect.objectContaining({
                id: "lkc-abc123",
                environment: "env-abc123",
              }),
            }),
          }),
        });
      });
    });
  });
});
