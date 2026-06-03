import type { paths } from "@src/confluent/openapi-schema.js";
import type { FlinkStatementMeta } from "@src/confluent/tools/handlers/flink/flink-sql-helper.js";
import { createRetryOn429Middleware } from "@tests/harness/retry-on-429.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import type { CallToolResponse } from "@tests/harness/tool-results.js";
import { setTimeout as sleep } from "node:timers/promises";
import createClient, { type Client } from "openapi-fetch";
import { afterAll } from "vitest";

// mirrors the documented phase values on `sql.v1.StatementStatus.phase` in
// `src/confluent/openapi-schema.d.ts` (typed as `string` upstream; we keep an explicit union here
// for autocomplete and typo detection at call sites)
type FlinkStatementPhase =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "DELETING"
  | "FAILING"
  | "FAILED"
  | "STOPPED";

const TERMINAL_FAILURE_PHASES: readonly FlinkStatementPhase[] = [
  "FAILED",
  "FAILING",
];

interface FlinkScope {
  organizationId: string;
  environmentId: string;
  computePoolId: string;
  endpoint: string;
  authKey: string;
  authSecret: string;
}

function getFlinkScope(): FlinkScope {
  const conn = integrationRuntime().config.getSoleDirectConnection();
  if (!conn.flink) {
    throw new Error(
      "test-side flink helpers require flink config in test-fixtures/yaml_configs/integration.yaml",
    );
  }
  return {
    organizationId: conn.flink.organization_id,
    environmentId: conn.flink.environment_id,
    computePoolId: conn.flink.compute_pool_id,
    endpoint: conn.flink.endpoint,
    authKey: conn.flink.auth.key,
    authSecret: conn.flink.auth.secret,
  };
}

function newTestFlinkClient(scope: FlinkScope): Client<paths> {
  const basic = Buffer.from(`${scope.authKey}:${scope.authSecret}`).toString(
    "base64",
  );
  const client = createClient<paths>({
    baseUrl: scope.endpoint,
    headers: { Authorization: `Basic ${basic}` },
  });
  // smooths transient CCloud rate limiting during full-suite runs (provision/teardown across
  // many flink test files compounds against the per-account quota)
  client.use(createRetryOn429Middleware());
  return client;
}

/**
 * Submits a Flink SQL statement (defaults to `SELECT 1`) and resolves once
 * the POST returns. CCloud's submit returns immediately with phase PENDING;
 * tests that just need the statement to exist (read, list, exceptions, health)
 * can proceed without waiting for RUNNING.
 */
export async function provisionTestFlinkStatement(
  name: string,
  sql = "SELECT 1",
): Promise<void> {
  const scope = getFlinkScope();
  const client = newTestFlinkClient(scope);
  const { error } = await client.POST(
    "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements",
    {
      params: {
        path: {
          organization_id: scope.organizationId,
          environment_id: scope.environmentId,
        },
      },
      body: {
        name,
        organization_id: scope.organizationId,
        environment_id: scope.environmentId,
        spec: {
          compute_pool_id: scope.computePoolId,
          statement: sql,
        },
      },
    },
  );
  if (error) {
    throw new Error(
      `failed to provision test flink statement ${name}: ${JSON.stringify(error)}`,
    );
  }
}

/**
 * Polls until the statement reaches one of `targetPhases`, or throws on
 * timeout. Uses a vanilla async loop rather than `expect.poll` so it's
 * callable from outside of a test context (e.g. before/after hooks).
 */
export async function waitForFlinkStatementPhase(
  name: string,
  targetPhases: FlinkStatementPhase | readonly FlinkStatementPhase[],
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const { timeoutMs = 30_000, intervalMs = 2_000 } = opts;
  const acceptable = Array.isArray(targetPhases)
    ? targetPhases
    : [targetPhases];
  const scope = getFlinkScope();
  const client = newTestFlinkClient(scope);
  const deadline = Date.now() + timeoutMs;
  let lastPhase: string | undefined;
  while (Date.now() < deadline) {
    const { data, error } = await client.GET(
      "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{statement_name}",
      {
        params: {
          path: {
            organization_id: scope.organizationId,
            environment_id: scope.environmentId,
            statement_name: name,
          },
        },
      },
    );
    if (error) {
      throw new Error(
        `failed to GET flink statement ${name}: ${JSON.stringify(error)}`,
      );
    }
    lastPhase = data?.status?.phase;
    if (acceptable.includes(lastPhase as FlinkStatementPhase)) {
      return;
    }
    // short-circuit on terminal-failure phases the caller didn't ask for, so CI surfaces the
    // real failure (with the API's `status.detail`) instead of waiting out the timeout
    if (TERMINAL_FAILURE_PHASES.includes(lastPhase as FlinkStatementPhase)) {
      throw new Error(
        `flink statement ${name} entered ${lastPhase} while waiting for [${acceptable.join(", ")}]: ${data?.status?.detail ?? "no detail"}`,
      );
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `flink statement ${name} did not reach any of phases [${acceptable.join(", ")}] within ${timeoutMs}ms (last phase: ${lastPhase ?? "unknown"})`,
  );
}

/**
 * DELETE the named statement. Tolerates 404 silently because the
 * delete-statement test deletes via the tool, so teardown's 404 isn't a real
 * failure. Logs other failures to stderr; {@linkcode withSharedFlinkStatementCleanup}
 * uses `Promise.allSettled`, so logging is the only path that surfaces them.
 */
export async function deleteTestFlinkStatement(name: string): Promise<void> {
  const scope = getFlinkScope();
  const client = newTestFlinkClient(scope);
  const { error, response } = await client.DELETE(
    "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{statement_name}",
    {
      params: {
        path: {
          organization_id: scope.organizationId,
          environment_id: scope.environmentId,
          statement_name: name,
        },
      },
    },
  );
  if (error && response.status !== 404) {
    console.error(
      `failed to delete test flink statement ${name} (status ${response.status}): ${JSON.stringify(error)}`,
    );
  }
}

/**
 * Registers an `afterAll` at the calling describe scope to delete any tracked
 * statements. Tests push names onto `createdStatements` as they create them;
 * the sweep is best-effort so a teardown failure can't fail an already-asserted
 * test.
 */
export function withSharedFlinkStatementCleanup(): {
  createdStatements: string[];
} {
  const createdStatements: string[] = [];
  afterAll(async () => {
    await Promise.allSettled(
      createdStatements.map((n) => deleteTestFlinkStatement(n)),
    );
  });
  return { createdStatements };
}

/**
 * Reads `_meta.flinkStatementsCreated` from a tool-call result and pushes names onto
 * {@linkcode createdStatements} for sweep by {@linkcode withSharedFlinkStatementCleanup}'s `afterAll`.
 */
export function trackStatementsFromMeta(
  result: CallToolResponse,
  createdStatements: string[],
): void {
  const names = (result._meta as Partial<FlinkStatementMeta> | undefined)
    ?.flinkStatementsCreated;
  if (Array.isArray(names) && names.length > 0) {
    createdStatements.push(...names.filter((n) => typeof n === "string"));
  }
}

/**
 * Parses a list-databases response and returns the friendly SCHEMA_NAME for
 * the given cluster id, or `undefined` if the cluster isn't catalogued in the
 * Flink workspace. The friendly name is what TABLE_SCHEMA filters expect.
 */
export function findFriendlySchemaName(
  listDatabasesText: string,
  clusterId: string,
): string | undefined {
  const jsonStart = listDatabasesText.indexOf("[");
  const jsonEnd = listDatabasesText.lastIndexOf("]");
  if (jsonStart < 0 || jsonEnd < jsonStart) return undefined;
  // handler emits raw Flink-SQL row payloads of shape `{ row: [SCHEMA_ID, SCHEMA_NAME] }`
  const databases = JSON.parse(
    listDatabasesText.slice(jsonStart, jsonEnd + 1),
  ) as Array<{ row: [string, string] }>;
  return databases.find((d) => d.row[0] === clusterId)?.row[1];
}
