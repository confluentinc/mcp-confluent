import { BaseClientManager } from "@src/confluent/base-client-manager.js";
import * as nodeDeps from "@src/confluent/node-deps.js";
import { OAuthClientManager } from "@src/confluent/oauth-client-manager.js";
import * as resolvers from "@src/confluent/oauth-resource-resolvers.js";
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

  describe("getSchemaRegistrySdkClient (cluster-aware, OAuth, per-call build)", () => {
    it("resolves the SR endpoint once per cluster_id and reuses it across builds", async () => {
      const fakeHolder = {
        getControlPlaneToken: () => "cp-tok",
        getDataPlaneToken: () => "dp-tok",
      } as unknown as OAuthHolder;

      const resolverSpy = vi
        .spyOn(resolvers, "resolveSchemaRegistryEndpoint")
        .mockResolvedValue("https://psrc-abc.example.com");

      const manager = new OAuthClientManager(fakeHolder, "devel");
      const c1 = await manager.getSchemaRegistrySdkClient("lsrc-abc", "env-1");
      const c2 = await manager.getSchemaRegistrySdkClient("lsrc-abc", "env-1");
      // Per-call build — c1 and c2 should not be the same instance.
      expect(c1).not.toBe(c2);
      // But endpoint resolution is cached → resolver called once.
      expect(resolverSpy).toHaveBeenCalledTimes(1);
    });

    it("re-resolves the endpoint for a different cluster_id", async () => {
      const fakeHolder = {
        getControlPlaneToken: () => "cp-tok",
        getDataPlaneToken: () => "dp-tok",
      } as unknown as OAuthHolder;
      const resolverSpy = vi
        .spyOn(resolvers, "resolveSchemaRegistryEndpoint")
        .mockResolvedValue("https://psrc.example.com");
      const manager = new OAuthClientManager(fakeHolder, "devel");
      await manager.getSchemaRegistrySdkClient("lsrc-a", "env-1");
      await manager.getSchemaRegistrySdkClient("lsrc-b", "env-1");
      expect(resolverSpy).toHaveBeenCalledTimes(2);
    });

    it("throws when args are missing under OAuth", async () => {
      const fakeHolder = {
        getControlPlaneToken: () => "cp-tok",
        getDataPlaneToken: () => "dp-tok",
      } as unknown as OAuthHolder;
      const manager = new OAuthClientManager(fakeHolder, "devel");
      await expect(
        manager.getSchemaRegistrySdkClient(undefined, undefined),
      ).rejects.toThrow(/cluster_id.*environment_id.*required/i);
    });

    it("disconnect() drains the SR endpoint resolution cache", async () => {
      vi.spyOn(resolvers, "resolveSchemaRegistryEndpoint").mockResolvedValue(
        "https://psrc.example.com",
      );
      const fakeHolder = {
        getControlPlaneToken: () => "cp-tok",
        getDataPlaneToken: () => "dp-tok",
      } as unknown as OAuthHolder;
      const manager = new OAuthClientManager(fakeHolder, "devel");
      await manager.getSchemaRegistrySdkClient("lsrc-abc", "env-1");
      await expect(manager.disconnect()).resolves.toBeUndefined();
    });
  });

  describe("cluster-aware Kafka accessors (OAuth, cached)", () => {
    function stubKafkaConstructor(): {
      lastAdmin: () => {
        connect: ReturnType<typeof vi.fn>;
        disconnect: ReturnType<typeof vi.fn>;
      };
    } {
      let capturedAdmin = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
      };
      vi.spyOn(nodeDeps.kafkaDeps, "Kafka").mockImplementation(function () {
        const instanceAdmin = {
          connect: vi.fn().mockResolvedValue(undefined),
          disconnect: vi.fn().mockResolvedValue(undefined),
        };
        capturedAdmin = instanceAdmin;
        return {
          admin: () => instanceAdmin,
          producer: () => ({
            connect: vi.fn().mockResolvedValue(undefined),
            disconnect: vi.fn().mockResolvedValue(undefined),
          }),
          consumer: () => ({}),
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      return { lastAdmin: () => capturedAdmin };
    }

    it("getKafkaAdminClient resolves bootstrap once and caches the admin per cluster_id", async () => {
      stubKafkaConstructor();
      const fakeHolder = {
        getControlPlaneToken: () => "cp-tok",
        getDataPlaneToken: () => "dp-tok",
      } as unknown as OAuthHolder;

      const resolverSpy = vi
        .spyOn(resolvers, "resolveKafkaBootstrap")
        .mockResolvedValue("lkc-abc.us-east-1.aws.confluent.cloud:9092");

      const manager = new OAuthClientManager(fakeHolder, "devel");
      const a1 = await manager.getKafkaAdminClient("lkc-abc", "env-1");
      const a2 = await manager.getKafkaAdminClient("lkc-abc", "env-1");
      expect(a1).toBe(a2);
      expect(resolverSpy).toHaveBeenCalledTimes(1);

      const a3 = await manager.getKafkaAdminClient("lkc-other", "env-1");
      expect(a3).not.toBe(a1);
      expect(resolverSpy).toHaveBeenCalledTimes(2);
    });

    it("getKafkaProducer caches per cluster_id with same semantics as admin", async () => {
      stubKafkaConstructor();
      const fakeHolder = {
        getControlPlaneToken: () => "cp-tok",
        getDataPlaneToken: () => "dp-tok",
      } as unknown as OAuthHolder;
      vi.spyOn(resolvers, "resolveKafkaBootstrap").mockResolvedValue(
        "lkc-abc.us-east-1.aws.confluent.cloud:9092",
      );
      const manager = new OAuthClientManager(fakeHolder, "devel");
      const p1 = await manager.getKafkaProducer("lkc-abc", "env-1");
      const p2 = await manager.getKafkaProducer("lkc-abc", "env-1");
      expect(p1).toBe(p2);
    });

    it("buildKafkaConsumer returns a fresh consumer each call but reuses the bootstrap cache", async () => {
      stubKafkaConstructor();
      const fakeHolder = {
        getControlPlaneToken: () => "cp-tok",
        getDataPlaneToken: () => "dp-tok",
      } as unknown as OAuthHolder;
      const resolverSpy = vi
        .spyOn(resolvers, "resolveKafkaBootstrap")
        .mockResolvedValue("lkc-abc.us-east-1.aws.confluent.cloud:9092");
      const manager = new OAuthClientManager(fakeHolder, "devel");
      const c1 = await manager.buildKafkaConsumer("lkc-abc", "env-1");
      const c2 = await manager.buildKafkaConsumer("lkc-abc", "env-1");
      expect(c1).not.toBe(c2);
      expect(resolverSpy).toHaveBeenCalledTimes(1);
    });

    it("missing args under OAuth throw a discovery-hint error", async () => {
      stubKafkaConstructor();
      const fakeHolder = {
        getControlPlaneToken: () => "cp-tok",
        getDataPlaneToken: () => "dp-tok",
      } as unknown as OAuthHolder;
      const manager = new OAuthClientManager(fakeHolder, "devel");
      await expect(
        manager.getKafkaAdminClient(undefined, undefined),
      ).rejects.toThrow(/cluster_id.*environment_id.*required/i);
    });

    it("disconnect() drains kafka caches with awaited disconnect()", async () => {
      const { lastAdmin } = stubKafkaConstructor();
      vi.spyOn(resolvers, "resolveKafkaBootstrap").mockResolvedValue(
        "lkc-abc.us-east-1.aws.confluent.cloud:9092",
      );
      const fakeHolder = {
        getControlPlaneToken: () => "cp-tok",
        getDataPlaneToken: () => "dp-tok",
      } as unknown as OAuthHolder;
      const manager = new OAuthClientManager(fakeHolder, "devel");
      await manager.getKafkaAdminClient("lkc-abc", "env-1");
      await manager.disconnect();
      expect(lastAdmin().disconnect).toHaveBeenCalledTimes(1);
    });
  });
});
