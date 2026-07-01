import { ListOrganizationsHandler } from "@src/confluent/tools/handlers/organizations/list-organizations-handler.js";
import {
  CCLOUD_CONN,
  DEFAULT_CONNECTION_ID,
  runtimeWithDecoy,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  type HandleCase,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

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

    describe("handle()", () => {
      type OrgsCase = HandleCase & { cloudGetData: unknown };
      const cases: OrgsCase[] = [
        {
          label:
            "resolve with 'Retrieved 0 organizations' when the API returns an empty list",
          args: {},
          cloudGetData: {
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
          cloudGetData: {
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
          cloudGetData: {
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
          cloudGetData: { not: "an OrganizationList" },
          outcome: { resolves: "Invalid organization list data" },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({ args, outcome, cloudGetData }) => {
          const clientManager = getMockedClientManager();
          clientManager
            .getConfluentCloudRestClient()
            .GET.mockResolvedValue({ data: cloudGetData });
          await assertHandleCase({
            handler,
            runtime: runtimeWithDecoy(
              CCLOUD_CONN,
              DEFAULT_CONNECTION_ID,
              clientManager,
            ),
            args,
            outcome,
            clientManager,
          });
        },
      );

      it("should resolve with an isError response carrying the API error body when the REST call returns an error", async () => {
        const clientManager = getMockedClientManager();
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          error: { status: 403, detail: "Forbidden" },
        });
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CCLOUD_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: {
            resolves:
              'Failed to fetch organizations: {"status":403,"detail":"Forbidden"}',
            isError: true,
          },
          clientManager,
        });
      });

      it("should resolve with an isError response carrying the thrown error message when the REST call rejects", async () => {
        const clientManager = getMockedClientManager();
        clientManager
          .getConfluentCloudRestClient()
          .GET.mockRejectedValue(new Error("connection reset by peer"));
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CCLOUD_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: {},
          outcome: {
            resolves: "Failed to fetch organizations: connection reset by peer",
            isError: true,
          },
          clientManager,
        });
      });
    });
  });
});
