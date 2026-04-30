import { DefaultClientManager } from "@src/confluent/client-manager.js";
import { ListOrganizationsHandler } from "@src/confluent/tools/handlers/organizations/list-organizations-handler.js";
import {
  bareRuntime,
  ccloudOAuthRuntime,
  confluentCloudRuntime,
  DEFAULT_CONNECTION_ID,
} from "@tests/factories/runtime.js";
import { createMockInstance } from "@tests/stubs/index.js";
import { describe, expect, it, vi } from "vitest";

describe("list-organizations-handler.ts", () => {
  describe("ListOrganizationsHandler", () => {
    const handler = new ListOrganizationsHandler();

    describe("enabledConnectionIds()", () => {
      it("should return the connection ID under an api_key (confluent_cloud) runtime", () => {
        expect(handler.enabledConnectionIds(confluentCloudRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return every connection ID under a ccloud-oauth runtime, regardless of per-connection blocks", () => {
        expect(handler.enabledConnectionIds(ccloudOAuthRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });

      it("should return an empty array when neither OAuth nor a confluent_cloud block is configured", () => {
        expect(handler.enabledConnectionIds(bareRuntime())).toEqual([]);
      });
    });

    describe("handle()", () => {
      it("should return the parsed organization list on success", async () => {
        const clientManager = createMockInstance(DefaultClientManager);
        const mockGet = vi.fn().mockResolvedValue({
          data: {
            api_version: "org/v2",
            kind: "OrganizationList",
            data: [
              {
                api_version: "org/v2",
                kind: "Organization",
                id: "o-12345",
                metadata: {
                  created_at: "2026-04-01T00:00:00Z",
                  updated_at: "2026-04-15T00:00:00Z",
                  resource_name: "crn://confluent.cloud/organization=o-12345",
                  self: "https://api.confluent.cloud/org/v2/organizations/o-12345",
                },
                display_name: "Acme Org",
              },
            ],
          },
          error: undefined,
        });
        clientManager.getConfluentCloudRestClient.mockReturnValue({
          GET: mockGet,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);

        const result = await handler.handle(clientManager, {});

        expect(mockGet).toHaveBeenCalledWith(
          "/org/v2/organizations",
          expect.any(Object),
        );
        expect(result.isError).toBe(false);
        expect(result._meta?.organizations).toEqual([
          {
            id: "o-12345",
            name: "Acme Org",
            resource_name: "crn://confluent.cloud/organization=o-12345",
            created_at: "2026-04-01T00:00:00Z",
            updated_at: "2026-04-15T00:00:00Z",
          },
        ]);
      });
    });
  });
});
