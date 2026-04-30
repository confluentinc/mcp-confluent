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
      it("should return the connection ID under an api_key (confluent_cloud) runtime", () => {
        expect(handler.enabledConnectionIds(confluentCloudRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return the connection ID under a ccloud-oauth runtime", () => {
        expect(handler.enabledConnectionIds(ccloudOAuthRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array when neither OAuth nor a confluent_cloud block is configured", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });
    });
  });
});
