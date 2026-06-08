import { ListEnvironmentsHandler } from "@src/confluent/tools/handlers/environments/list-environments-handler.js";
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

describe("list-environments-handler.ts", () => {
  describe("ListEnvironmentsHandler", () => {
    const handler = new ListEnvironmentsHandler();

    // Every case runs against runtimeWithDecoy, so assertHandleCase routes to
    // the real connection and asserts the decoy's client manager stays
    // untouched — making each a routing test for the resolveConnection port.
    describe("handle()", () => {
      type EnvsCase = HandleCase & { cloudGetData: unknown };
      const cases: EnvsCase[] = [
        {
          label:
            "resolve with 'retrieved 0 environments' when the API returns an empty list",
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
            "resolve with the environment's display name when the API returns one entry",
          args: {},
          cloudGetData: {
            api_version: "org/v2",
            kind: "EnvironmentList",
            data: [ENV_FIXTURE],
          },
          outcome: { resolves: "production" },
        },
        {
          label:
            "resolve with a validation-error response when the API returns an unexpected payload",
          args: {},
          cloudGetData: { not: "an EnvironmentList" },
          outcome: { resolves: "Invalid environment list data", isError: true },
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
    });
  });
});
