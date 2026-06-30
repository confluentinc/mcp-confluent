import { BaseClientManager } from "@src/confluent/base-client-manager.js";
import type { components } from "@src/confluent/openapi-schema.js";
import { logger } from "@src/logger.js";
import { wrapAsPathBasedClient } from "openapi-fetch";

export interface FlinkSqlResult {
  success: boolean;
  data?: unknown[];
  error?: string;
  statementName?: string;
  phase?: string;
}

/**
 * `_meta` payload emitted by catalog handlers so integration tests can sweep
 * statements the handler created internally. {@linkcode executeFlinkSql}
 * best-effort deletes its own bounded statements once they complete; this
 * ride-along remains as a backstop for the cases where that delete fails.
 *
 * Declared as `type` rather than `interface` so the shape is assignable to
 * {@link BaseToolHandler.createResponse}'s `_meta: Record<string, unknown>`
 * parameter; interfaces are excluded from that target by declaration-merging
 * rules (microsoft/TypeScript#15300).
 */
export type FlinkStatementMeta = {
  flinkStatementsCreated: string[];
};

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
  clientManager: BaseClientManager,
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
    await clientManager.getFlinkRestClient(computePoolId, environmentId),
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
      // Hidden keeps these service-internal queries out of statement-listing
      // surfaces (console, monitoring, our own list tool). The generated schema
      // marks metadata.self required even on create, though self is a
      // server-set read-only URL the client must not send; cast past it.
      metadata: {
        labels: { "user.confluent.io/hidden": "true" },
      } as unknown as components["schemas"]["sql.v1.Statement"]["metadata"],
      spec: {
        compute_pool_id: computePoolId,
        statement: sql,
        properties: {
          // snapshot.mode=now declares the bounded, point-in-time intent our
          // poll-to-COMPLETED loop already depends on, rather than leaning on
          // CCloud's implicit INFORMATION_SCHEMA special-casing.
          "sql.snapshot.mode": "now",
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

  // Bounded query is drained, so the statement is a spent resource: delete it
  // to reclaim quota. Best-effort — a failed DELETE must not flip a successful
  // query to an error, and the hidden label keeps any orphan out of listings.
  try {
    const { error: deleteError } = await pathBasedClient[
      "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{statement_name}"
    ].DELETE({
      params: {
        path: {
          organization_id: organizationId,
          environment_id: environmentId,
          statement_name: statementName,
        },
      },
    });
    if (deleteError) {
      logger.warn(
        { deleteError, statementName },
        "Failed to delete completed internal Flink query statement",
      );
    }
  } catch (err) {
    logger.warn(
      { err, statementName },
      "Failed to delete completed internal Flink query statement",
    );
  }

  return {
    success: true,
    data: allResults,
    statementName,
    phase,
  };
}
