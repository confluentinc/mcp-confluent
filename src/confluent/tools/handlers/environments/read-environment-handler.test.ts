import { ReadEnvironmentHandler } from "@src/confluent/tools/handlers/environments/read-environment-handler.js";
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

// A fully-populated environment exercising the optional rendering arms:
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

// Mock behavior for the single GET the handler issues to /org/v2/environments/{id}.
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

describe("read-environment-handler.ts", () => {
  describe("ReadEnvironmentHandler", () => {
    const handler = new ReadEnvironmentHandler();

    // Every case runs against runtimeWithDecoy, so assertHandleCase routes to
    // the real connection and asserts the decoy's client manager stays
    // untouched — making each a routing test for the resolveConnection port.
    describe("handle()", () => {
      type ReadEnvCase = HandleCase & { get?: GetBehavior };
      const cases: ReadEnvCase[] = [
        {
          label: "resolve with the environment's display name on success",
          args: { environmentId: "env-abc123" },
          get: { data: ENV_FIXTURE },
          outcome: { resolves: "production" },
        },
        {
          label: "resolve with an error response when the API returns an error",
          args: { environmentId: "env-abc123" },
          get: { apiError: { message: "not found" } },
          outcome: { resolves: "Failed to fetch environment", isError: true },
        },
        {
          label:
            "surface the underlying message when the GET rejects with an Error",
          args: { environmentId: "env-abc123" },
          get: { rejects: new Error("connection reset") },
          outcome: { resolves: "connection reset", isError: true },
        },
        {
          label:
            "stringify the thrown value when the GET rejects with a non-Error",
          args: { environmentId: "env-abc123" },
          get: { rejects: "raw string failure" },
          outcome: { resolves: "raw string failure", isError: true },
        },
        {
          label:
            "resolve with a validation-error response on an unexpected payload",
          args: { environmentId: "env-abc123" },
          get: { data: { not: "an Environment" } },
          outcome: { resolves: "Invalid environment data", isError: true },
        },
        {
          label: "throw a ZodError when environmentId is absent",
          args: {},
          outcome: { throws: "ZodError" },
        },
      ];

      it.each(cases)("should $label", async ({ args, outcome, get }) => {
        const clientManager = getMockedClientManager();
        if (get) {
          configureGet(clientManager, get);
        }
        await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CCLOUD_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args,
          outcome,
          // The ZodError case throws before reaching the client layer.
          clientManager: get ? clientManager : undefined,
        });
      });

      it("should render deleted-at and stream-governance for a fully-populated environment", async () => {
        const clientManager = getMockedClientManager();
        configureGet(clientManager, { data: RICH_ENV_FIXTURE });

        const result = await assertHandleCase({
          handler,
          runtime: runtimeWithDecoy(
            CCLOUD_CONN,
            DEFAULT_CONNECTION_ID,
            clientManager,
          ),
          args: { environmentId: "env-rich9" },
          outcome: { resolves: "staging", isError: false },
          clientManager,
        });

        expect(result!._meta).toEqual({
          environment: {
            api_version: "org/v2",
            kind: "Environment",
            id: "env-rich9",
            name: "staging",
            metadata: {
              created_at: "2024-03-01T00:00:00Z",
              updated_at: "2024-03-02T00:00:00Z",
              deleted_at: "2024-03-03T00:00:00Z",
              resource_name: "crn://confluent.cloud/environment=env-rich9",
              self: "https://api.confluent.cloud/org/v2/environments/env-rich9",
            },
            stream_governance_package: "ADVANCED",
          },
        });

        const text = textOf(result!);
        expect(text).toContain("Deleted At: 2024-03-03T00:00:00Z");
        expect(text).toContain("Stream Governance Package: ADVANCED");
      });
    });
  });
});
