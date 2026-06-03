import { ListEnvironmentsHandler } from "@src/confluent/tools/handlers/environments/list-environments-handler.js";
import {
  CCLOUD_CONN,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  assertHandleCase,
  getMockedClientManager,
  type HandleCase,
} from "@tests/stubs/index.js";
import { describe, it } from "vitest";

const ENV_FIXTURE = {
  api_version: "org/v2",
  kind: "Environment",
  id: "env-abc123",
  metadata: {
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-02T00:00:00Z",
    resource_name: "crn://confluent.cloud/environment=env-abc123",
    self: "https://api.confluent.cloud/org/v2/environments/env-abc123",
  },
  display_name: "Production",
};

// Exercises the optional-field branches: deleted_at and stream_governance_config.
const ENV_FIXTURE_FULL = {
  ...ENV_FIXTURE,
  id: "env-deleted",
  metadata: {
    ...ENV_FIXTURE.metadata,
    deleted_at: "2024-02-01T00:00:00Z",
    resource_name: "crn://confluent.cloud/environment=env-deleted",
    self: "https://api.confluent.cloud/org/v2/environments/env-deleted",
  },
  display_name: "Decommissioned",
  stream_governance_config: { package: "ADVANCED" },
};

describe("list-environments-handler.ts", () => {
  describe("ListEnvironmentsHandler", () => {
    const handler = new ListEnvironmentsHandler();

    describe("handle()", () => {
      type EnvsCase = HandleCase & {
        cloudGetData?: unknown;
        cloudGetError?: unknown;
      };
      const cases: EnvsCase[] = [
        {
          label:
            "resolve with 0 environments when the API returns an empty list",
          args: {},
          cloudGetData: {
            api_version: "org/v2",
            kind: "EnvironmentList",
            data: [],
          },
          outcome: { resolves: "Successfully retrieved 0 environments" },
        },
        {
          label:
            "resolve with the environment display name when the API returns one entry",
          args: {},
          cloudGetData: {
            api_version: "org/v2",
            kind: "EnvironmentList",
            data: [ENV_FIXTURE],
          },
          outcome: { resolves: "Production" },
        },
        {
          label:
            "render deleted_at and stream governance when those optional fields are present",
          args: {},
          cloudGetData: {
            api_version: "org/v2",
            kind: "EnvironmentList",
            data: [ENV_FIXTURE_FULL],
          },
          outcome: { resolves: "Stream Governance Package: ADVANCED" },
        },
        {
          label: "render pagination info when metadata is present",
          args: { pageToken: "TOKEN" },
          cloudGetData: {
            api_version: "org/v2",
            kind: "EnvironmentList",
            metadata: {
              total_size: 1,
              next: "https://api.confluent.cloud/org/v2/environments?page_token=NEXT",
            },
            data: [ENV_FIXTURE],
          },
          outcome: { resolves: "Total Environments: 1" },
        },
        {
          label: "resolve with an error response when the API returns an error",
          args: {},
          cloudGetError: { message: "boom" },
          outcome: { resolves: "Failed to fetch environments", isError: true },
        },
        {
          label:
            "resolve with a validation-error response when the payload is unexpected",
          args: {},
          cloudGetData: { not: "an EnvironmentList" },
          outcome: { resolves: "Invalid environment list data", isError: true },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({ args, outcome, cloudGetData, cloudGetError }) => {
          const clientManager = getMockedClientManager();
          clientManager
            .getConfluentCloudRestClient()
            .GET.mockResolvedValue(
              cloudGetError ? { error: cloudGetError } : { data: cloudGetData },
            );
          await assertHandleCase({
            handler,
            runtime: runtimeWith(
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
    });
  });
});
