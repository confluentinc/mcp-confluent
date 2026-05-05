import { ClientManager } from "@src/confluent/client-manager.js";
import { getEnsuredParam } from "@src/confluent/helpers.js";
import { config, nodeFetch } from "@src/confluent/node-deps.js";
import { CallToolResult } from "@src/confluent/schema.js";
import {
  BaseToolHandler,
  READ_ONLY,
  ToolConfig,
} from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import {
  CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS,
  EnvVar,
} from "@src/env-schema.js";
import { wrapAsPathBasedClient } from "openapi-fetch";
import { z } from "zod";

const LOGGING_API_BASE = "https://api.logging.confluent.cloud";
const PLATFORM_BASE = "https://confluent.cloud";
const TRACE_LINE_LIMIT = 10;
const TRACE_CHAR_LIMIT = 800;

const getConnectorLogsArguments = z.object({
  environmentId: z
    .string()
    .trim()
    .optional()
    .describe(
      "The unique identifier for the environment this resource belongs to. Falls back to KAFKA_ENV_ID env var.",
    ),
  clusterId: z
    .string()
    .trim()
    .optional()
    .describe(
      "The unique identifier for the Kafka cluster. Falls back to KAFKA_CLUSTER_ID env var.",
    ),
  organizationId: z
    .string()
    .trim()
    .optional()
    .describe(
      "The Confluent Cloud organization ID. Falls back to CONFLUENT_CLOUD_ORG_ID env var, then auto-resolves via GET /org/v2/organizations.",
    ),
  connectorName: z
    .string()
    .trim()
    .nonempty()
    .describe("The unique name of the connector."),
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
    let detail = "";
    try {
      detail = await response.text();
    } catch {
      // ignore — surface status alone
    }
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

async function resolveOrganizationId(
  clientManager: ClientManager,
  argOrgId: string | undefined,
): Promise<string> {
  if (argOrgId) return argOrgId;
  const envOrgId = config.env.CONFLUENT_CLOUD_ORG_ID;
  if (envOrgId) return envOrgId;

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
    throw new Error(
      "Failed to auto-resolve organization ID: GET /org/v2/organizations returned no organizations. Pass organizationId or set CONFLUENT_CLOUD_ORG_ID.",
    );
  }
  return first;
}

export class GetConnectorLogsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const args = getConnectorLogsArguments.parse(toolArguments);
    const environment_id = getEnsuredParam(
      "KAFKA_ENV_ID",
      "Environment ID is required",
      args.environmentId,
    );
    const kafka_cluster_id = getEnsuredParam(
      "KAFKA_CLUSTER_ID",
      "Kafka Cluster ID is required",
      args.clusterId,
    );
    const env = config.env;
    const apiKey = env.CONFLUENT_CLOUD_API_KEY;
    const apiSecret = env.CONFLUENT_CLOUD_API_SECRET;
    if (!apiKey || !apiSecret) {
      throw new Error(
        "CONFLUENT_CLOUD_API_KEY and CONFLUENT_CLOUD_API_SECRET are required to authenticate against the logging API.",
      );
    }
    const organization_id = await resolveOrganizationId(
      clientManager,
      args.organizationId,
    );

    const now = new Date();
    const endTime = args.endTime ?? isoSecondsZ(now);
    const startTime =
      args.startTime ??
      isoSecondsZ(new Date(new Date(endTime).getTime() - 60 * 60 * 1000));
    const levels = args.levels ?? ["ERROR"];
    const pageSize = args.pageSize ?? 100;
    const crn = buildCrn(
      organization_id,
      environment_id,
      kafka_cluster_id,
      args.connectorName,
    );

    const search: Record<string, unknown> = { level: levels };
    if (args.connectorId) {
      search.id = args.connectorId;
    }
    const body = {
      crn,
      search,
      sort: "desc",
      start_time: startTime,
      end_time: endTime,
    };

    let dataPlaneToken: string;
    try {
      dataPlaneToken = await exchangeForDataPlaneToken(apiKey, apiSecret);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.createResponse(
        `Failed to fetch logs for connector ${args.connectorName}: ${message}`,
        true,
      );
    }

    const queryParams = new URLSearchParams({ page_size: String(pageSize) });
    if (args.pageToken) {
      queryParams.set("page_token", args.pageToken);
    }
    const url = `${LOGGING_API_BASE}/logs/v1/search?${queryParams.toString()}`;
    const authHeader = `Bearer ${dataPlaneToken}`;

    let response: Response;
    try {
      response = await nodeFetch.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: authHeader,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.createResponse(
        `Failed to fetch logs for connector ${args.connectorName}: ${message}`,
        true,
      );
    }

    if (!response.ok) {
      let detail = "";
      try {
        detail = await response.text();
      } catch {
        // ignore — surface status alone
      }
      return this.createResponse(
        `Logging API returned ${response.status} for connector ${args.connectorName}: ${detail || response.statusText}`,
        true,
      );
    }

    let parsed: LogsResponse;
    try {
      parsed = (await response.json()) as LogsResponse;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.createResponse(
        `Failed to parse logs response for connector ${args.connectorName}: ${message}`,
        true,
      );
    }

    const data = parsed.data ?? [];
    if (data.length === 0) {
      return this.createResponse(
        `No log entries for connector ${args.connectorName} in the requested window (${startTime} to ${endTime}, levels=${levels.join(",")}).`,
      );
    }

    const entries = data.map<ProjectedLogEntry>((e) => {
      const projected: ProjectedLogEntry = {};
      if (e.timestamp) projected.timestamp = e.timestamp;
      if (e.level) projected.level = e.level;
      if (e.task_id) projected.taskId = e.task_id;
      if (e.message) projected.message = e.message;
      const stacktraceHead = truncateStacktrace(e.exception?.stacktrace);
      if (stacktraceHead) projected.stacktraceHead = stacktraceHead;
      return projected;
    });

    const projection: LogsProjection = {
      connectorName: args.connectorName,
      startTime,
      endTime,
      levels,
      totalEntries: entries.length,
      entries,
    };
    const next = parsed.metadata?.next;
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

  getRequiredEnvVars(): readonly EnvVar[] {
    return CCLOUD_CONTROL_PLANE_REQUIRED_ENV_VARS;
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
