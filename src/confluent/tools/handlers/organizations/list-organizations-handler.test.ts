import { ListOrganizationsHandler } from "@src/confluent/tools/handlers/organizations/list-organizations-handler.js";
import {
  bareRuntime,
  ccloudOAuthRuntime,
  confluentCloudRuntime,
  DEFAULT_CONNECTION_ID,
} from "@tests/factories/runtime.js";
import { describe, expect, it } from "vitest";

describe("list-organizations-handler.ts", () => {
  describe("ListOrganizationsHandler", () => {
    const handler = new ListOrganizationsHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID for a connection with a confluent_cloud block", () => {
        expect(handler.enabledConnectionIds(confluentCloudRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array for a connection without a confluent_cloud block", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });

      it("should return an empty array under a ccloud-oauth runtime whose synth connection lacks a confluent_cloud block", () => {
        // Known regression vs. the inline bypass that previously enabled the tool
        // under any OAuth runtime — collapses once the connection-shape migration
        // lets the OAuth synth carry a confluent_cloud block.
        expect(handler.enabledConnectionIds(ccloudOAuthRuntime())).toEqual([]);
      });
    });
  });
});
