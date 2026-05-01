import { BaseClientManager } from "@src/confluent/client-manager.js";
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

    describe("getKafkaClient()", () => {
      it("should throw the OAuth-specific error", () => {
        const cm = new OAuthClientManager(fakeOAuthHolder(), "devel");
        expect(() => cm.getKafkaClient()).toThrow(
          /Native Kafka client is not available under OAuth/,
        );
      });
    });

    describe("getAdminClient()", () => {
      it("should reject with the OAuth-specific error", async () => {
        const cm = new OAuthClientManager(fakeOAuthHolder(), "devel");
        await expect(cm.getAdminClient()).rejects.toThrow(
          /Native Kafka client is not available under OAuth/,
        );
      });
    });

    describe("getProducer()", () => {
      it("should reject with the OAuth-specific error", async () => {
        const cm = new OAuthClientManager(fakeOAuthHolder(), "devel");
        await expect(cm.getProducer()).rejects.toThrow(
          /Native Kafka client is not available under OAuth/,
        );
      });
    });

    describe("getConsumer()", () => {
      it("should reject with the OAuth-specific error", async () => {
        const cm = new OAuthClientManager(fakeOAuthHolder(), "devel");
        await expect(cm.getConsumer()).rejects.toThrow(
          /Native Kafka client is not available under OAuth/,
        );
      });
    });

    describe("getSchemaRegistryClient()", () => {
      it("should throw an OAuth-specific error that points to the REST client", () => {
        const cm = new OAuthClientManager(fakeOAuthHolder(), "devel");
        expect(() => cm.getSchemaRegistryClient()).toThrow(
          /Schema Registry SDK client is not available under OAuth/,
        );
      });

      it("should not surface the BaseClientManager api_key-only error message", () => {
        const cm = new OAuthClientManager(fakeOAuthHolder(), "devel");
        expect(() => cm.getSchemaRegistryClient()).not.toThrow(
          /SCHEMA_REGISTRY_API_KEY/,
        );
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
