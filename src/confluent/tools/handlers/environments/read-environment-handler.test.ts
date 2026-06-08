import { ReadEnvironmentHandler } from "@src/confluent/tools/handlers/environments/read-environment-handler.js";
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

describe("read-environment-handler.ts", () => {
  describe("ReadEnvironmentHandler", () => {
    const handler = new ReadEnvironmentHandler();

    // Every case runs against runtimeWithDecoy, so assertHandleCase routes to
    // the real connection and asserts the decoy's client manager stays
    // untouched — making each a routing test for the resolveConnection port.
    describe("handle()", () => {
      type ReadEnvCase = HandleCase & { cloudGetData?: unknown };
      const cases: ReadEnvCase[] = [
        {
          label: "resolve with the environment's display name on success",
          args: { environmentId: "env-abc123" },
          cloudGetData: ENV_FIXTURE,
          outcome: { resolves: "production" },
        },
        {
          label: "resolve with an error response when the API returns an error",
          args: { environmentId: "env-abc123" },
          cloudGetData: undefined,
          outcome: { resolves: "Failed to fetch environment", isError: true },
        },
        {
          label:
            "resolve with a validation-error response on an unexpected payload",
          args: { environmentId: "env-abc123" },
          cloudGetData: { not: "an Environment" },
          outcome: { resolves: "Invalid environment data", isError: true },
        },
        {
          label: "throw a ZodError when environmentId is absent",
          args: {},
          outcome: { throws: "ZodError" },
        },
      ];

      it.each(cases)(
        "should $label",
        async ({ args, outcome, cloudGetData }) => {
          const clientManager = getMockedClientManager();
          clientManager
            .getConfluentCloudRestClient()
            .GET.mockResolvedValue(
              cloudGetData === undefined
                ? { error: { message: "not found" } }
                : { data: cloudGetData },
            );
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
