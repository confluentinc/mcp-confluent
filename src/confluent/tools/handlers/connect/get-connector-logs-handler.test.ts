import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import { GetConnectorLogsHandler } from "@src/confluent/tools/handlers/connect/get-connector-logs-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  CONNECT_CONN,
  DEFAULT_CONNECTION_ID,
  runtimeWith,
} from "@tests/factories/runtime.js";
import {
  getMockedClientManager,
  mockFetch,
  type MockedClientManager,
  type MockedFetch,
} from "@tests/stubs/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const STACKTRACE = `io.debezium.DebeziumException: Couldn't obtain encoding for database test
\tat io.debezium.connector.v2.postgresql.connection.PostgresConnection.getDatabaseCharset(PostgresConnection.java:608)
\tat io.debezium.connector.v2.postgresql.PostgresConnectorTask.start(PostgresConnectorTask.java:98)
Caused by: org.postgresql.util.PSQLException: FATAL: password authentication failed for user "postgres"`;

const TEST_DATAPLANE_TOKEN = "dp-test-token";

/** Connection config with the confluent_cloud credentials the handler reads. */
const CONNECT_CONN_WITH_CC = {
  ...CONNECT_CONN,
  confluent_cloud: {
    endpoint: "https://api.confluent.cloud",
    auth: { type: "api_key" as const, key: "test-key", secret: "test-secret" },
  },
};

/** Same connection but with an explicit organization_id pinned in config. */
const CONNECT_CONN_WITH_ORG_ID = {
  ...CONNECT_CONN,
  confluent_cloud: {
    endpoint: "https://api.confluent.cloud",
    auth: { type: "api_key" as const, key: "test-key", secret: "test-secret" },
    organization_id: "config-org-id",
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tokenResponse(token: string = TEST_DATAPLANE_TOKEN): Response {
  return jsonResponse({ token });
}

describe("get-connector-logs-handler.ts", () => {
  describe("GetConnectorLogsHandler", () => {
    const handler = new GetConnectorLogsHandler();
    let clientManager: MockedClientManager;
    let fetchSpy: MockedFetch;

    const baseArgs = {
      environmentId: "env-63yg9q",
      clusterId: "lkc-6p56yj",
      organizationId: "6bb93e12-57c1-4ae6-9ae0-f677d83a6bf7",
      connectorName: "cypher-source",
    };

    beforeEach(() => {
      clientManager = getMockedClientManager();
      fetchSpy = mockFetch();
    });

    function callHandle(
      args: Record<string, unknown> = baseArgs,
      connectionConfig: Parameters<
        typeof runtimeWith
      >[0] = CONNECT_CONN_WITH_CC,
    ) {
      const runtime = runtimeWith(
        connectionConfig,
        DEFAULT_CONNECTION_ID,
        clientManager,
      );
      return handler.handle(runtime, args);
    }

    describe("getToolConfig()", () => {
      it("should return GET_CONNECTOR_LOGS with READ_ONLY annotations", () => {
        const config = handler.getToolConfig();
        expect(config.name).toBe(ToolName.GET_CONNECTOR_LOGS);
        expect(config.annotations).toBe(READ_ONLY);
      });
    });

    describe("handle()", () => {
      it("should exchange API key for a data-plane token then call the logging API with Bearer auth", async () => {
        const entries = [
          {
            exception: { stacktrace: STACKTRACE },
            level: "ERROR",
            task_id: "task-0",
            id: "lcc-oo0vvx",
            message:
              "WorkerSourceTask{id=lcc-oo0vvx-0} Task threw an uncaught and unrecoverable exception",
            timestamp: "2026-04-29T04:47:22.097Z",
          },
          {
            exception: { stacktrace: STACKTRACE },
            level: "ERROR",
            task_id: "task-0",
            id: "lcc-oo0vvx",
            message:
              "WorkerSourceTask{id=lcc-oo0vvx-0} Task threw an uncaught and unrecoverable exception",
            timestamp: "2026-04-29T04:42:15.575Z",
          },
        ];
        fetchSpy
          .mockResolvedValueOnce(tokenResponse())
          .mockResolvedValueOnce(jsonResponse({ data: entries }));

        const result = await callHandle({
          ...baseArgs,
          startTime: "2026-04-29T03:50:13Z",
          endTime: "2026-04-29T04:50:13Z",
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Logs for cypher-source");
        const projection = JSON.parse(text.slice(text.indexOf("{")));
        expect(projection.totalEntries).toBe(2);
        expect(projection.entries[0]).toMatchObject({
          timestamp: "2026-04-29T04:47:22.097Z",
          level: "ERROR",
          taskId: "task-0",
        });
        expect(projection.entries[0].stacktraceHead).toContain(
          "DebeziumException",
        );

        expect(fetchSpy).toHaveBeenCalledTimes(2);

        // Call 1: token exchange
        const [tokenUrl, tokenInit] = fetchSpy.mock.calls[0]!;
        expect(String(tokenUrl)).toBe(
          "https://confluent.cloud/api/access_tokens",
        );
        expect(tokenInit?.method).toBe("POST");
        const tokenHeaders = tokenInit?.headers as Record<string, string>;
        expect(tokenHeaders["Authorization"]).toBe(
          `Basic ${Buffer.from("test-key:test-secret").toString("base64")}`,
        );
        expect(tokenInit?.body).toBe("{}");

        // Call 2: logs search
        const [logsUrl, logsInit] = fetchSpy.mock.calls[1]!;
        expect(String(logsUrl)).toBe(
          "https://api.logging.confluent.cloud/logs/v1/search?page_size=100",
        );
        expect(logsInit?.method).toBe("POST");
        const logsHeaders = logsInit?.headers as Record<string, string>;
        expect(logsHeaders["Authorization"]).toBe(
          `Bearer ${TEST_DATAPLANE_TOKEN}`,
        );
        const sentBody = JSON.parse(logsInit?.body as string);
        expect(sentBody.crn).toBe(
          "crn://confluent.cloud/organization=6bb93e12-57c1-4ae6-9ae0-f677d83a6bf7/environment=env-63yg9q/cloud-cluster=lkc-6p56yj/connector=cypher-source",
        );
        expect(sentBody.search).toEqual({ level: ["ERROR"] });
        expect(sentBody.sort).toBe("desc");
        expect(sentBody.start_time).toBe("2026-04-29T03:50:13Z");
        expect(sentBody.end_time).toBe("2026-04-29T04:50:13Z");
      });

      it("should include search.id and override pageSize when connectorId/pageSize are provided", async () => {
        fetchSpy
          .mockResolvedValueOnce(tokenResponse())
          .mockResolvedValueOnce(jsonResponse({ data: [] }));

        await callHandle({
          ...baseArgs,
          connectorId: "lcc-oo0vvx",
          levels: ["ERROR", "WARN"],
          pageSize: 200,
          startTime: "2026-04-29T03:50:13Z",
          endTime: "2026-04-29T04:50:13Z",
        });

        const [logsUrl, logsInit] = fetchSpy.mock.calls[1]!;
        expect(String(logsUrl)).toContain("page_size=200");
        const sentBody = JSON.parse(logsInit?.body as string);
        expect(sentBody.search).toEqual({
          level: ["ERROR", "WARN"],
          id: "lcc-oo0vvx",
        });
      });

      it("should forward pageToken as a query param and surface nextPageToken from metadata.next", async () => {
        fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
          jsonResponse({
            data: [
              {
                level: "ERROR",
                task_id: "task-0",
                timestamp: "2026-04-29T04:00:00Z",
                message: "first page entry",
              },
            ],
            metadata: { next: "next-page-opaque-token" },
          }),
        );

        const result = await callHandle({
          ...baseArgs,
          pageToken: "incoming-page-token",
          startTime: "2026-04-29T03:50:13Z",
          endTime: "2026-04-29T04:50:13Z",
        });

        const [logsUrl] = fetchSpy.mock.calls[1]!;
        const url = new URL(String(logsUrl));
        expect(url.searchParams.get("page_size")).toBe("100");
        expect(url.searchParams.get("page_token")).toBe("incoming-page-token");

        const text = (result.content[0] as { text: string }).text;
        const projection = JSON.parse(text.slice(text.indexOf("{")));
        expect(projection.nextPageToken).toBe("next-page-opaque-token");
      });

      it("should omit page_token from the URL and nextPageToken from the projection when neither is present", async () => {
        fetchSpy.mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(
          jsonResponse({
            data: [
              {
                level: "ERROR",
                task_id: "task-0",
                timestamp: "2026-04-29T04:00:00Z",
                message: "only page",
              },
            ],
          }),
        );

        const result = await callHandle({
          ...baseArgs,
          startTime: "2026-04-29T03:50:13Z",
          endTime: "2026-04-29T04:50:13Z",
        });

        const [logsUrl] = fetchSpy.mock.calls[1]!;
        const url = new URL(String(logsUrl));
        expect(url.searchParams.has("page_token")).toBe(false);

        const text = (result.content[0] as { text: string }).text;
        const projection = JSON.parse(text.slice(text.indexOf("{")));
        expect(projection).not.toHaveProperty("nextPageToken");
      });

      it("should default the time window to the last hour when not provided", async () => {
        fetchSpy
          .mockResolvedValueOnce(tokenResponse())
          .mockResolvedValueOnce(jsonResponse({ data: [] }));
        const fixedNow = new Date("2026-04-29T05:00:00Z");
        vi.useFakeTimers();
        vi.setSystemTime(fixedNow);

        try {
          await callHandle(baseArgs);
        } finally {
          vi.useRealTimers();
        }

        const [, logsInit] = fetchSpy.mock.calls[1]!;
        const sentBody = JSON.parse(logsInit?.body as string);
        expect(sentBody.end_time).toBe("2026-04-29T05:00:00Z");
        expect(sentBody.start_time).toBe("2026-04-29T04:00:00Z");
      });

      it("should return a one-liner when no log entries are returned", async () => {
        fetchSpy
          .mockResolvedValueOnce(tokenResponse())
          .mockResolvedValueOnce(jsonResponse({ data: [] }));

        const result = await callHandle({
          ...baseArgs,
          startTime: "2026-04-29T03:50:13Z",
          endTime: "2026-04-29T04:50:13Z",
        });

        expect(result.isError).toBeFalsy();
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("No log entries for connector cypher-source");
        expect(text).toContain("levels=ERROR");
      });

      it("should surface a non-2xx response from the logging API as an error", async () => {
        fetchSpy
          .mockResolvedValueOnce(tokenResponse())
          .mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

        const result = await callHandle();

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("403");
        expect(text).toContain("forbidden");
      });

      it("should surface a token-exchange failure as an error before hitting the logging API", async () => {
        fetchSpy.mockResolvedValueOnce(
          new Response("unauthorized", { status: 401 }),
        );

        const result = await callHandle();

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Failed to fetch logs");
        expect(text).toContain("data-plane token");
        expect(text).toContain("401");
        // Logging API must not be called when token exchange fails.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      it("should surface a token-exchange response missing the token field", async () => {
        fetchSpy.mockResolvedValueOnce(jsonResponse({}));

        const result = await callHandle();

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Failed to fetch logs");
        expect(text).toContain("missing 'token'");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
      });

      it("should surface fetch failures as an error", async () => {
        fetchSpy
          .mockResolvedValueOnce(tokenResponse())
          .mockRejectedValueOnce(new Error("ECONNRESET"));

        const result = await callHandle();

        expect(result.isError).toBe(true);
        const text = (result.content[0] as { text: string }).text;
        expect(text).toContain("Failed to fetch logs");
        expect(text).toContain("ECONNRESET");
      });

      it("should auto-resolve organization ID via /org/v2/organizations when not provided", async () => {
        const cloudRest = clientManager.getConfluentCloudRestClient();
        cloudRest.GET.mockResolvedValue({
          data: { data: [{ id: "auto-resolved-org-id" }] },
        });
        fetchSpy
          .mockResolvedValueOnce(tokenResponse())
          .mockResolvedValueOnce(jsonResponse({ data: [] }));

        await callHandle({
          environmentId: "env-63yg9q",
          clusterId: "lkc-6p56yj",
          connectorName: "cypher-source",
          startTime: "2026-04-29T03:50:13Z",
          endTime: "2026-04-29T04:50:13Z",
        });

        expect(cloudRest.GET).toHaveBeenCalledOnce();
        expect(cloudRest.GET.mock.calls[0]![0]).toBe("/org/v2/organizations");
        const [, logsInit] = fetchSpy.mock.calls[1]!;
        const sentBody = JSON.parse(logsInit?.body as string);
        expect(sentBody.crn).toContain("organization=auto-resolved-org-id");
      });

      it("should prefer confluent_cloud.organization_id from config over auto-resolution", async () => {
        const cloudRest = clientManager.getConfluentCloudRestClient();
        fetchSpy
          .mockResolvedValueOnce(tokenResponse())
          .mockResolvedValueOnce(jsonResponse({ data: [] }));

        await callHandle(
          {
            environmentId: "env-63yg9q",
            clusterId: "lkc-6p56yj",
            connectorName: "cypher-source",
            startTime: "2026-04-29T03:50:13Z",
            endTime: "2026-04-29T04:50:13Z",
          },
          CONNECT_CONN_WITH_ORG_ID,
        );

        expect(cloudRest.GET).not.toHaveBeenCalled();
        const [, logsInit] = fetchSpy.mock.calls[1]!;
        const sentBody = JSON.parse(logsInit?.body as string);
        expect(sentBody.crn).toContain("organization=config-org-id");
      });

      it("should throw when auto-resolution returns an empty organization list", async () => {
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          data: { data: [] },
        });

        await expect(
          callHandle({
            environmentId: "env-1",
            clusterId: "lkc-1",
            connectorName: "c",
          }),
        ).rejects.toThrow(/no organizations/);
      });

      it("should throw when auto-resolution call itself fails", async () => {
        clientManager.getConfluentCloudRestClient().GET.mockResolvedValue({
          error: { error_code: 401, message: "unauthenticated" },
        });

        await expect(
          callHandle({
            environmentId: "env-1",
            clusterId: "lkc-1",
            connectorName: "c",
          }),
        ).rejects.toThrow(/Failed to auto-resolve organization ID/);
      });
    });
  });
});
