import type { ConnectionConfig } from "@src/config/models.js";
import type { BaseClientManager } from "@src/confluent/base-client-manager.js";
import { nodeFetch } from "@src/confluent/node-deps.js";
import type { OAuthHolder } from "@src/confluent/oauth/oauth-holder.js";
import type { CallToolResult } from "@src/confluent/schema.js";
import type { ToolConfig } from "@src/confluent/tools/base-tools.js";
import { READ_ONLY } from "@src/confluent/tools/base-tools.js";
import {
  ConnectToolHandler,
  connectorByNameArguments,
} from "@src/confluent/tools/handlers/connect/connect-tool-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import type { ServerRuntime } from "@src/server-runtime.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const LOGGING_API_BASE = "https://api.logging.confluent.cloud";
const PLATFORM_BASE = "https://confluent.cloud";
const TRACE_LINE_LIMIT = 10;
const TRACE_CHAR_LIMIT = 800;

const getConnectorLogsArguments = connectorByNameArguments.extend({
  organizationId: z
    .string()
    .trim()
    .optional()
    .describe(
      "The Confluent Cloud organization ID. Falls back to the connection's confluent_cloud.organization_id, then auto-resolves via GET /org/v2/organizations.",
    ),
  connectorId: z
    .string()
    .trim()
    .optional()
    .describe(
      "Optional connector resource ID (e.g. 'lcc-abc123'). When provided, narrows the log search by connector ID.",
    ),
  levels: z
    .array(z.enum(["ERROR", "WARN", "INFO", "DEBUG", "TRACE"]))
    .nonempty()
    .optional()
    .describe('Log levels to include. Defaults to ["ERROR"] if not specified.'),
  startTime: z
    .string()
    .trim()
    .optional()
    .describe(
      "ISO 8601 start time (e.g. '2026-04-29T03:50:13Z'). Defaults to one hour before endTime.",
    ),
  endTime: z
    .string()
    .trim()
    .optional()
    .describe(
      "ISO 8601 end time (e.g. '2026-04-29T04:50:13Z'). Defaults to the current time.",
    ),
  pageSize: z
    .number()
    .int()
    .positive()
    .max(200)
    .optional()
    .describe(
      "Maximum number of log entries to return per page (default 100, max 200).",
    ),
  pageToken: z
    .string()
    .trim()
    .optional()
    .describe(
      "Opaque pagination token from a prior call's nextPageToken response field. Pass to retrieve the next page of results.",
    ),
});

interface LogException {
  stacktrace?: string;
}

interface LogEntry {
  timestamp?: string;
  level?: string;
  task_id?: string;
  id?: string;
  message?: string;
  exception?: LogException;
}

interface LogsResponse {
  data?: LogEntry[];
  metadata?: {
    next?: string;
  };
}

interface ProjectedLogEntry {
  timestamp?: string;
  level?: string;
  taskId?: string;
  message?: string;
  stacktraceHead?: string;
}

interface LogsProjection {
  connectorName: string;
  startTime: string;
  endTime: string;
  levels: string[];
  totalEntries: number;
  entries: ProjectedLogEntry[];
  nextPageToken?: string;
}

function truncateStacktrace(trace: string | undefined): string | undefined {
  if (!trace) return undefined;
  const trimmed = trace.trimEnd();
  if (!trimmed) return undefined;
  const lines = trimmed.split("\n");
  let head = lines.slice(0, TRACE_LINE_LIMIT).join("\n");
  const truncatedByLines = lines.length > TRACE_LINE_LIMIT;
  let truncatedByChars = false;
  if (head.length > TRACE_CHAR_LIMIT) {
    head = head.slice(0, TRACE_CHAR_LIMIT);
    truncatedByChars = true;
  }
  return truncatedByLines || truncatedByChars
    ? `${head}\n... [truncated]`
    : head;
}

function isoSecondsZ(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

function buildCrn(
  organizationId: string,
  environmentId: string,
  clusterId: string,
  connectorName: string,
): string {
  return `crn://confluent.cloud/organization=${organizationId}/environment=${environmentId}/cloud-cluster=${clusterId}/connector=${connectorName}`;
}

/**
 * Exchanges a Cloud API key/secret for a short-lived data-plane bearer token by
 * POSTing to {PLATFORM_BASE}/api/access_tokens with HTTP Basic auth. The
 * resulting Bearer token is what api.logging.confluent.cloud accepts; Basic
 * auth with the API key directly is rejected with a 401.
 */
async function exchangeForDataPlaneToken(
  apiKey: string,
  apiSecret: string,
): Promise<string> {
  const url = `${PLATFORM_BASE}/api/access_tokens`;
  const basicAuth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
  const response = await nodeFetch.fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuth,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: "{}",
  });
  if (!response.ok) {
    const detail = await readBodyTextSafe(response);
    throw new Error(
      `Failed to exchange API key for data-plane token (HTTP ${response.status}): ${detail || response.statusText}`,
    );
  }
  const json = (await response.json()) as { token?: string };
  if (!json.token) {
    throw new Error(
      "Data-plane token response missing 'token' field; cannot authenticate against the logging API.",
    );
  }
  return json.token;
}

/**
 * Resolves the bearer token for the connector logging API.
 *
 * - OAuth: the data-plane token read straight from the {@link OAuthHolder} (the
 *   server's token authority — kept separate from the client manager, which only
 *   hands out clients). The logging API is a data-plane surface and rejects the
 *   control-plane token with a 401; the data-plane token is the audience it
 *   accepts. Throws if none is available.
 * - Direct: exchanges the connection's `confluent_cloud` API key/secret for a
 *   short-lived data-plane token via `/api/access_tokens`.
 */
async function resolveLogsBearerToken(
  conn: ConnectionConfig,
  oauthHolder: OAuthHolder | undefined,
): Promise<string> {
  if (conn.type === "oauth") {
    const token = oauthHolder?.getDataPlaneToken();
    if (!token) {
      throw new Error(
        "No OAuth data-plane token available to authenticate against the logging API.",
      );
    }
    return token;
  }
  const ccAuth = conn.confluent_cloud?.auth;
  if (!ccAuth) {
    throw new Error(
      "confluent_cloud.auth is required to authenticate against the logging API.",
    );
  }
  return exchangeForDataPlaneToken(ccAuth.key, ccAuth.secret);
}

async function resolveOrganizationId(
  clientManager: BaseClientManager,
  conn: ConnectionConfig,
  argOrgId: string | undefined,
): Promise<string> {
  if (argOrgId) return argOrgId;
  const configOrgId =
    conn.type === "direct" ? conn.confluent_cloud?.organization_id : undefined;
  if (configOrgId) return configOrgId;

  const pathBasedClient = wrapAsPathBasedClient(
    clientManager.getConfluentCloudRestClient(),
  );
  const { data, error } = await pathBasedClient["/org/v2/organizations"].GET(
    {},
  );
  if (error) {
    throw new Error(
      `Failed to auto-resolve organization ID via GET /org/v2/organizations: ${JSON.stringify(error)}`,
    );
  }
  const first = data?.data?.[0]?.id;
  if (!first) {
    // The config-fallback hint only applies to direct connections — an OAuth
    // connection has no `confluent_cloud` block to set `organization_id` on.
    const fallbackHint =
      conn.type === "direct"
        ? "Pass organizationId or set confluent_cloud.organization_id in the connection config."
        : "Pass organizationId.";
    throw new Error(
      `Failed to auto-resolve organization ID: GET /org/v2/organizations returned no organizations. ${fallbackHint}`,
    );
  }
  return first;
}

export class GetConnectorLogsHandler extends ConnectToolHandler {
  async handle(
    runtime: ServerRuntime,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const args = getConnectorLogsArguments.parse(toolArguments);

    const { conn, clientManager } = this.resolveConnection(
      runtime,
      toolArguments,
    );
    const { environment_id, kafka_cluster_id } =
      this.resolveConnectEnvAndClusterId(
        conn,
        args.environmentId,
        args.clusterId,
      );

    const organization_id = await resolveOrganizationId(
      clientManager,
      conn,
      args.organizationId,
    );

    const crn = buildCrn(
      organization_id,
      environment_id,
      kafka_cluster_id,
      args.connectorName,
    );
    const request = buildLogsRequest(args, crn);

    const outcome = await fetchConnectorLogs(
      conn,
      runtime.oauthHolder,
      request,
      args.connectorName,
    );
    if (outcome.kind === "error") {
      return this.createResponse(outcome.message, true);
    }

    const data = outcome.parsed.data ?? [];
    if (data.length === 0) {
      return this.createResponse(
        `No log entries for connector ${args.connectorName} in the requested window (${request.startTime} to ${request.endTime}, levels=${request.levels.join(",")}).`,
      );
    }

    const entries = data.map(projectLogEntry);
    const projection: LogsProjection = {
      connectorName: args.connectorName,
      startTime: request.startTime,
      endTime: request.endTime,
      levels: request.levels,
      totalEntries: entries.length,
      entries,
    };
    const next = outcome.parsed.metadata?.next;
    if (typeof next === "string" && next.length > 0) {
      projection.nextPageToken = next;
    }

    return this.createResponse(
      `Logs for ${args.connectorName}: ${JSON.stringify(projection)}`,
    );
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_CONNECTOR_LOGS,
      description:
        "Retrieve recent log entries for a Confluent Cloud connector from the Cloud logging API. Defaults to the last hour of ERROR-level entries with truncated stacktraces. Use connectorId (lcc-...) to narrow by resource ID. Organization ID auto-resolves from GET /org/v2/organizations when not provided. Paginated: when the response includes a nextPageToken, call again with pageToken=<that value> to retrieve the next page.",
      inputSchema: getConnectorLogsArguments.shape,
      annotations: READ_ONLY,
    };
  }
}

/**
 * Extracts a human-readable message from an unknown caught value, since a
 * `catch` binding is `unknown` and may not be an `Error`.
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reads a response body as text, swallowing a decode failure so the caller can
 * surface the HTTP status alone rather than masking it with a body-read error.
 */
async function readBodyTextSafe(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * The assembled logging-API search call plus the resolved window and levels the
 * handler echoes back into the projection and the empty-result message — so
 * those defaults are computed once, in one place, rather than re-derived.
 */
interface LogsRequest {
  url: string;
  body: {
    crn: string;
    search: Record<string, unknown>;
    sort: string;
    start_time: string;
    end_time: string;
  };
  startTime: string;
  endTime: string;
  levels: string[];
}

/**
 * Assembles the logging-API search request from the parsed tool arguments,
 * applying the defaults (last-hour window, ERROR level, page size 100) and the
 * optional connector-id / page-token narrowing.
 */
function buildLogsRequest(
  args: z.infer<typeof getConnectorLogsArguments>,
  crn: string,
): LogsRequest {
  const endTime = args.endTime ?? isoSecondsZ(new Date());
  const startTime =
    args.startTime ??
    isoSecondsZ(new Date(new Date(endTime).getTime() - 60 * 60 * 1000));
  const levels = args.levels ?? ["ERROR"];
  const pageSize = args.pageSize ?? 100;

  const search: Record<string, unknown> = { level: levels };
  if (args.connectorId) {
    search.id = args.connectorId;
  }

  const queryParams = new URLSearchParams({ page_size: String(pageSize) });
  if (args.pageToken) {
    queryParams.set("page_token", args.pageToken);
  }

  return {
    url: `${LOGGING_API_BASE}/logs/v1/search?${queryParams.toString()}`,
    body: {
      crn,
      search,
      sort: "desc",
      start_time: startTime,
      end_time: endTime,
    },
    startTime,
    endTime,
    levels,
  };
}

/**
 * Projects a raw logging-API entry into the trimmed shape returned to the
 * caller: absent fields are dropped rather than emitted as undefined, and the
 * stacktrace is truncated to a head snippet.
 */
function projectLogEntry(e: LogEntry): ProjectedLogEntry {
  const projected: ProjectedLogEntry = {};
  if (e.timestamp) projected.timestamp = e.timestamp;
  if (e.level) projected.level = e.level;
  if (e.task_id) projected.taskId = e.task_id;
  if (e.message) projected.message = e.message;
  const stacktraceHead = truncateStacktrace(e.exception?.stacktrace);
  if (stacktraceHead) projected.stacktraceHead = stacktraceHead;
  return projected;
}

/**
 * Outcome of {@link fetchConnectorLogs}: either the parsed payload, or a
 * ready-to-surface error message covering whichever stage failed. Collapsing
 * the failure stages into one discriminated result gives the handler a single
 * branch instead of one per stage.
 */
type LogsFetchResult =
  | { kind: "ok"; parsed: LogsResponse }
  | { kind: "error"; message: string };

/**
 * Authenticates against and calls the logging search API, collapsing every
 * failure stage (token resolution, transport error, non-2xx status, unparseable
 * body) into a single error-carrying result so the caller has one branch to
 * handle rather than four try/catch arms. The distinct per-stage messages are
 * preserved verbatim.
 */
async function fetchConnectorLogs(
  conn: ConnectionConfig,
  oauthHolder: OAuthHolder | undefined,
  request: LogsRequest,
  connectorName: string,
): Promise<LogsFetchResult> {
  let bearerToken: string;
  try {
    bearerToken = await resolveLogsBearerToken(conn, oauthHolder);
  } catch (err) {
    return {
      kind: "error",
      message: `Failed to fetch logs for connector ${connectorName}: ${errMessage(err)}`,
    };
  }

  let response: Response;
  try {
    response = await nodeFetch.fetch(request.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify(request.body),
    });
  } catch (err) {
    return {
      kind: "error",
      message: `Failed to fetch logs for connector ${connectorName}: ${errMessage(err)}`,
    };
  }

  if (!response.ok) {
    const detail = await readBodyTextSafe(response);
    return {
      kind: "error",
      message: `Logging API returned ${response.status} for connector ${connectorName}: ${detail || response.statusText}`,
    };
  }

  try {
    return { kind: "ok", parsed: (await response.json()) as LogsResponse };
  } catch (err) {
    return {
      kind: "error",
      message: `Failed to parse logs response for connector ${connectorName}: ${errMessage(err)}`,
    };
  }
}
