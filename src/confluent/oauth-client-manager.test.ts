import { BaseClientManager } from "@src/confluent/base-client-manager.js";
import { OAuthClientManager } from "@src/confluent/oauth-client-manager.js";
import { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import { describe, expect, it, vi } from "vitest";

function fakeOAuthHolder(): OAuthHolder {
  return {
    getControlPlaneToken: () => "cp-token",
    getDataPlaneToken: () => "dp-token",
  } as unknown as OAuthHolder;
}

describe("oauth-client-manager.ts", () => {
  describe("OAuthClientManager", () => {
    describe("constructor", () => {
      it("should derive the cloud REST URL from the Auth0 env (devel)", () => {
        const cm = new OAuthClientManager(fakeOAuthHolder(), "devel");
        expect(cm["confluentCloudBaseUrl"]).toBe(
          "https://api.devel.cpdev.cloud",
        );
      });

      it("should derive the cloud REST URL from the Auth0 env (stag)", () => {
        const cm = new OAuthClientManager(fakeOAuthHolder(), "stag");
        expect(cm["confluentCloudBaseUrl"]).toBe(
          "https://api.stag.cpdev.cloud",
        );
      });

      it("should derive the cloud REST URL from the Auth0 env (prod)", () => {
        const cm = new OAuthClientManager(fakeOAuthHolder(), "prod");
        expect(cm["confluentCloudBaseUrl"]).toBe("https://api.confluent.cloud");
      });

      it("should reuse the cloud URL for the Tableflow base URL", () => {
        const cm = new OAuthClientManager(fakeOAuthHolder(), "stag");
        expect(cm["confluentCloudTableflowBaseUrl"]).toBe(
          cm["confluentCloudBaseUrl"],
        );
      });

      it("should leave data-plane endpoints undefined (filled in by a later layer)", () => {
        const cm = new OAuthClientManager(fakeOAuthHolder(), "stag");
        expect(cm["confluentCloudFlinkBaseUrl"]).toBeUndefined();
        expect(cm["confluentCloudSchemaRegistryBaseUrl"]).toBeUndefined();
        expect(cm["confluentCloudKafkaRestBaseUrl"]).toBeUndefined();
        expect(cm["confluentCloudTelemetryBaseUrl"]).toBeUndefined();
      });

      it("should eagerly materialize the cloud REST client at startup", () => {
        const eagerSpy = vi.spyOn(
          BaseClientManager.prototype,
          "getConfluentCloudRestClient",
        );
        new OAuthClientManager(fakeOAuthHolder(), "stag");
        expect(eagerSpy).toHaveBeenCalledOnce();
      });
    });

    describe("disconnect()", () => {
      it("should resolve without error (no native clients to clean up)", async () => {
        const cm = new OAuthClientManager(fakeOAuthHolder(), "devel");
        await expect(cm.disconnect()).resolves.toBeUndefined();
      });
    });
  });
});
