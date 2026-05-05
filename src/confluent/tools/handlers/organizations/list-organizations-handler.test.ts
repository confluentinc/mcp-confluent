import { ListOrganizationsHandler } from "@src/confluent/tools/handlers/organizations/list-organizations-handler.js";
import {
  bareRuntime,
  ccloudOAuthRuntime,
  confluentCloudRuntime,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  stubClientGetters,
  type HandleCase,
} from "@tests/stubs/index.js";
import { describe, expect, it } from "vitest";

const CCLOUD_CONN = {
  confluent_cloud: {
    endpoint: "https://api.confluent.cloud",
    auth: { type: "api_key" as const, key: "k", secret: "s" },
  },
};

const ORG_FIXTURE = {
  api_version: "org/v2",
  kind: "Organization",
  id: "org-abc123",
  display_name: "Acme Corp",
  metadata: {
    self: "https://api.confluent.cloud/org/v2/organizations/org-abc123",
    resource_name: "crn://confluent.cloud/organization=org-abc123",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  },
};

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

      it("should return the connection id when the connection is OAuth-typed", () => {
        expect(handler.enabledConnectionIds(ccloudOAuthRuntime())).toEqual([
          DEFAULT_CONNECTION_ID,
        ]);
      });
    });

    describe("handle()", () => {
      const cases: HandleCase[] = [
        {
          label:
            "resolve with 'Retrieved 0 organizations' when the API returns an empty list",
          args: {},
          responseData: {
            api_version: "org/v2",
            kind: "OrganizationList",
            data: [],
          },
          outcome: { resolves: "Retrieved 0 organizations" },
        },
        {
          label:
            "resolve with the organization's display name when the API returns one entry",
          args: {},
          responseData: {
            api_version: "org/v2",
            kind: "OrganizationList",
            data: [ORG_FIXTURE],
          },
          outcome: { resolves: "Acme Corp" },
        },
        {
          label:
            "include a 'more pages available' hint when metadata.next is present",
          args: { pageSize: 1 },
          responseData: {
            api_version: "org/v2",
            kind: "OrganizationList",
            metadata: {
              next: "https://api.confluent.cloud/org/v2/organizations?page_size=1&page_token=NEXT",
            },
            data: [ORG_FIXTURE],
          },
          outcome: { resolves: "more pages available" },
        },
        {
          label:
            "resolve with a validation-error response when the API returns an unexpected payload",
          args: {},
          responseData: { not: "an OrganizationList" },
          outcome: { resolves: "Invalid organization list data" },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({ args, outcome, responseData }) => {
          const { clientManager, clientGetters } =
            stubClientGetters(responseData);
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
              CCLOUD_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientGetters,
          });
        },
      );
    });
  });
});
