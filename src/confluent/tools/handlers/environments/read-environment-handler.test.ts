import { ReadEnvironmentHandler } from "@src/confluent/tools/handlers/environments/read-environment-handler.js";
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

const ENV_FIXTURE_FULL = {
  ...ENV_FIXTURE,
  metadata: {
    ...ENV_FIXTURE.metadata,
    deleted_at: "2024-02-01T00:00:00Z",
  },
  stream_governance_config: { package: "ADVANCED" },
};

describe("read-environment-handler.ts", () => {
  describe("ReadEnvironmentHandler", () => {
    const handler = new ReadEnvironmentHandler();

    describe("handle()", () => {
      type ReadCase = HandleCase & {
        cloudGetData?: unknown;
        cloudGetError?: unknown;
      };
      const cases: ReadCase[] = [
        {
          label: "resolve with the environment details on success",
          args: { environmentId: "env-abc123" },
          cloudGetData: ENV_FIXTURE,
          outcome: { resolves: "Production" },
        },
        {
          label:
            "render deleted_at and stream governance when those optional fields are present",
          args: { environmentId: "env-abc123" },
          cloudGetData: ENV_FIXTURE_FULL,
          outcome: { resolves: "Stream Governance Package: ADVANCED" },
        },
        {
          label: "resolve with an error response when the API returns an error",
          args: { environmentId: "env-abc123" },
          cloudGetError: { message: "not found" },
          outcome: { resolves: "Failed to fetch environment", isError: true },
        },
        {
          label:
            "resolve with a validation-error response when the payload is unexpected",
          args: { environmentId: "env-abc123" },
          cloudGetData: { not: "an Environment" },
          outcome: { resolves: "Invalid environment data", isError: true },
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

      it("should throw a ZodError when environmentId is empty", async () => {
        const clientManager = getMockedClientManager();
        await assertHandleCase({
          handler,
          runtime: runtimeWith(
            CCLOUD_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { environmentId: "" },
          outcome: { throws: "ZodError" },
        });
      });
    });
  });
});
