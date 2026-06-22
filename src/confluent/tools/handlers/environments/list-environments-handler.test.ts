import { ListEnvironmentsHandler } from "@src/confluent/tools/handlers/environments/list-environments-handler.js";
import { textOf } from "@tests/call-tool-result.js";
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
import { describe, expect, it } from "vitest";

const ENV_FIXTURE = {
  api_version: "org/v2",
  kind: "Environment",
  id: "env-abc123",
  display_name: "production",
  metadata: {
    self: "https://api.confluent.cloud/org/v2/environments/env-abc123",
    resource_name: "crn://confluent.cloud/environment=env-abc123",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
  },
};

// A fully-populated environment exercising every optional rendering arm:
// metadata.deleted_at and stream_governance_config.package.
const RICH_ENV_FIXTURE = {
  api_version: "org/v2",
  kind: "Environment",
  id: "env-rich9",
  display_name: "staging",
  metadata: {
    self: "https://api.confluent.cloud/org/v2/environments/env-rich9",
    resource_name: "crn://confluent.cloud/environment=env-rich9",
    created_at: "2024-03-01T00:00:00Z",
    updated_at: "2024-03-02T00:00:00Z",
    deleted_at: "2024-03-03T00:00:00Z",
  },
  stream_governance_config: { package: "ADVANCED" },
};

// Every pagination link populated so the optional rendering arms all fire.
const FULL_LIST_METADATA = {
  total_size: 7,
  first: "https://api.confluent.cloud/org/v2/environments?page_token=first",
  last: "https://api.confluent.cloud/org/v2/environments?page_token=last",
  prev: "https://api.confluent.cloud/org/v2/environments?page_token=prev",
  next: "https://api.confluent.cloud/org/v2/environments?page_token=next",
};

// Mock behavior for the single GET the handler issues to /org/v2/environments.
type GetBehavior =
  | { data: unknown }
  | { apiError: unknown }
  | { rejects: unknown };

function configureGet(
  clientManager: ReturnType<typeof getMockedClientManager>,
  get: GetBehavior,
): void {
  const restGet = clientManager.getConfluentCloudRestClient().GET;
  if ("rejects" in get) {
    restGet.mockRejectedValue(get.rejects);
  } else if ("apiError" in get) {
    restGet.mockResolvedValue({ error: get.apiError });
  } else {
    restGet.mockResolvedValue({ data: get.data });
  }
}

describe("list-environments-handler.ts", () => {
  describe("ListEnvironmentsHandler", () => {
    const handler = new ListEnvironmentsHandler();

    // Every case runs against runtimeWithDecoy, so assertHandleCase routes to
    // the real connection and asserts the decoy's client manager stays
    // untouched — making each a routing test for the resolveConnection port.
    describe("handle()", () => {
      type EnvsCase = HandleCase & { get: GetBehavior };
      const cases: EnvsCase[] = [
        {
          label:
            "resolve with 'retrieved 0 environments' when the API returns an empty list",
          args: {},
          get: {
            data: { api_version: "org/v2", kind: "EnvironmentList", data: [] },
          },
          outcome: { resolves: "Successfully retrieved 0 environments" },
        },
        {
          label:
            "resolve with the environment's display name when the API returns one entry",
          args: {},
          get: {
            data: {
              api_version: "org/v2",
              kind: "EnvironmentList",
              data: [ENV_FIXTURE],
            },
          },
          outcome: { resolves: "production" },
        },
        {
          label:
            "resolve with a validation-error response when the API returns an unexpected payload",
          args: {},
          get: { data: { not: "an EnvironmentList" } },
          outcome: { resolves: "Invalid environment list data", isError: true },
        },
        {
          label:
            "resolve with an error response when the API itself returns an error",
          args: {},
          get: { apiError: { message: "forbidden" } },
          outcome: { resolves: "Failed to fetch environments", isError: true },
        },
        {
          label:
            "surface the underlying message when the GET rejects with an Error",
          args: {},
          get: { rejects: new Error("connection reset") },
          outcome: { resolves: "connection reset", isError: true },
        },
        {
          label:
            "stringify the thrown value when the GET rejects with a non-Error",
          args: {},
          get: { rejects: "raw string failure" },
          outcome: { resolves: "raw string failure", isError: true },
        },
      ];

      it.each(cases)("should $label", async ({ args, outcome, get }) => {
        const clientManager = getMockedClientManager();
        configureGet(clientManager, get);
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
      });

      it("should render a Pagination header but no link lines when metadata is present but empty", async () => {
        const clientManager = getMockedClientManager();
        configureGet(clientManager, {
          data: {
            api_version: "org/v2",
            kind: "EnvironmentList",
            metadata: {},
            data: [ENV_FIXTURE],
          },
        });

        const result = await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CCLOUD_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          outcome: { resolves: "Pagination:", isError: false },
          clientManager,
        });

        // The outer `metadata ?` guard is true (header renders), but every
        // inner link ternary takes its false arm — so no link line appears.
        const text = textOf(result!);
        expect(text).toContain("Pagination:");
        expect(text).not.toContain("Total Environments:");
        expect(text).not.toContain("First Page:");
        expect(text).not.toContain("Last Page:");
        expect(text).not.toContain("Previous Page:");
        expect(text).not.toContain("Next Page:");

        // _meta still carries a pagination object, with every link undefined.
        expect(result!._meta).toEqual({
          environments: [
            {
              id: "env-abc123",
              name: "production",
              created_at: "2024-01-01T00:00:00Z",
              updated_at: "2024-01-02T00:00:00Z",
              deleted_at: undefined,
              resource_name: "crn://confluent.cloud/environment=env-abc123",
              stream_governance: undefined,
            },
          ],
          total: undefined,
          pagination: {
            first: undefined,
            last: undefined,
            prev: undefined,
            next: undefined,
          },
        });
      });

      it("should render deleted-at, stream-governance, and every pagination link for a fully-populated response", async () => {
        const clientManager = getMockedClientManager();
        configureGet(clientManager, {
          data: {
            api_version: "org/v2",
            kind: "EnvironmentList",
            metadata: FULL_LIST_METADATA,
            data: [RICH_ENV_FIXTURE],
          },
        });

        const result = await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CCLOUD_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          // A pageToken arg exercises the query-param-provided path.
          args: { pageToken: "page-token-xyz" },
          outcome: { resolves: "staging", isError: false },
          clientManager,
        });

        expect(
          clientManager.getConfluentCloudRestClient().GET,
        ).toHaveBeenCalledWith("/org/v2/environments", {
          params: { query: { page_token: "page-token-xyz" } },
        });

        expect(result!._meta).toEqual({
          environments: [
            {
              id: "env-rich9",
              name: "staging",
              created_at: "2024-03-01T00:00:00Z",
              updated_at: "2024-03-02T00:00:00Z",
              deleted_at: "2024-03-03T00:00:00Z",
              resource_name: "crn://confluent.cloud/environment=env-rich9",
              stream_governance: "ADVANCED",
            },
          ],
          total: 7,
          pagination: {
            first: FULL_LIST_METADATA.first,
            last: FULL_LIST_METADATA.last,
            prev: FULL_LIST_METADATA.prev,
            next: FULL_LIST_METADATA.next,
          },
        });

        const text = textOf(result!);
        expect(text).toContain("Deleted At: 2024-03-03T00:00:00Z");
        expect(text).toContain("Stream Governance Package: ADVANCED");
        expect(text).toContain("Total Environments: 7");
        expect(text).toContain(`First Page: ${FULL_LIST_METADATA.first}`);
        expect(text).toContain(`Last Page: ${FULL_LIST_METADATA.last}`);
        expect(text).toContain(`Previous Page: ${FULL_LIST_METADATA.prev}`);
        expect(text).toContain(`Next Page: ${FULL_LIST_METADATA.next}`);
      });
    });
  });
});
