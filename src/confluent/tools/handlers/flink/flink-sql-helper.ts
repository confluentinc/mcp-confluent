import { ClientManager } from "@src/confluent/client-manager.js";
import { wrapAsPathBasedClient } from "openapi-fetch";

export interface FlinkSqlResult {
  success: boolean;
  data?: unknown[];
  error?: string;
  statementName?: string;
  phase?: string;
}

export interface FlinkSqlOptions {
  organizationId: string;
  environmentId: string;
  computePoolId: string;
  catalogName?: string;
  databaseName?: string;
  timeoutMs?: number;
}

/**
 * Generates a unique statement name for temporary queries.
 */
function generateStatementName(prefix: string = "mcp-query"): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `${prefix}-${timestamp}-${random}`;
}

/**
 * Executes a Flink SQL query and returns the results.
 * For bounded queries (like INFORMATION_SCHEMA), waits for statement to complete,
 * then fetches all results.
 */
export async function executeFlinkSql(
  clientManager: ClientManager,
  sql: string,
  options: FlinkSqlOptions,
): Promise<FlinkSqlResult> {
  const {
    organizationId,
    environmentId,
    computePoolId,
    catalogName,
    databaseName,
    timeoutMs = 30000,
  } = options;

  const statementName = generateStatementName();
  const pathBasedClient = wrapAsPathBasedClient(
    clientManager.getConfluentCloudFlinkRestClient(),
  );

  // Create the statement
  const { error: createError } = await pathBasedClient[
    "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements"
  ].POST({
    params: {
      path: {
        environment_id: environmentId,
        organization_id: organizationId,
      },
    },
    body: {
      name: statementName,
      organization_id: organizationId,
      environment_id: environmentId,
      spec: {
        compute_pool_id: computePoolId,
        statement: sql,
        properties: {
          ...(catalogName && { "sql.current-catalog": catalogName }),
          ...(databaseName && { "sql.current-database": databaseName }),
        },
      },
    },
  });

  if (createError) {
    return {
      success: false,
      error: `Failed to create statement: ${JSON.stringify(createError)}`,
      statementName,
    };
  }

  const startTime = Date.now();
  const hasTimedOut = () => Date.now() - startTime >= timeoutMs;

  // Wait for statement to reach a terminal state (COMPLETED, FAILED, STOPPED)
  let phase: string | undefined;
  while (!hasTimedOut()) {
    const { data: statementData, error: statusError } = await pathBasedClient[
      "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{statement_name}"
    ].GET({
      params: {
        path: {
          organization_id: organizationId,
          environment_id: environmentId,
          statement_name: statementName,
        },
      },
    });

    if (statusError) {
      return {
        success: false,
        error: `Failed to get statement status: ${JSON.stringify(statusError)}`,
        statementName,
      };
    }

    phase = statementData?.status?.phase;

    if (phase === "COMPLETED") {
      break;
    }

    if (phase === "FAILED") {
      const detail = statementData?.status?.detail || "Unknown error";
      return {
        success: false,
        error: `Statement failed: ${detail}`,
        statementName,
        phase,
      };
    }

    if (phase === "STOPPED" || phase === "DELETED") {
      return {
        success: false,
        error: `Statement was ${phase.toLowerCase()}`,
        statementName,
        phase,
      };
    }

    // Still PENDING or RUNNING, wait and retry
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (phase !== "COMPLETED") {
    return {
      success: false,
      error: `Statement timed out in ${phase} state`,
      statementName,
      phase,
    };
  }

  // Fetch all results (bounded query, so we should get everything)
  let allResults: unknown[] = [];
  let nextToken: string | undefined = undefined;

  do {
    const { data: response, error: readError } = await pathBasedClient[
      "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{name}/results"
    ].GET({
      params: {
        path: {
          organization_id: organizationId,
          environment_id: environmentId,
          name: statementName,
        },
        ...(nextToken ? { query: { page_token: nextToken } } : {}),
      },
    });

    if (readError) {
      return {
        success: false,
        error: `Failed to read results: ${JSON.stringify(readError)}`,
        statementName,
        phase,
      };
    }

    allResults = allResults.concat(response?.results?.data || []);
    nextToken = response?.metadata?.next?.split("page_token=")[1];
  } while (nextToken);

  return {
    success: true,
    data: allResults,
    statementName,
    phase,
  };
}
