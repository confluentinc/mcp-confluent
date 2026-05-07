import type { paths } from "@src/confluent/openapi-schema.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import createClient, { type Client } from "openapi-fetch";
import { afterAll } from "vitest";

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
  return createClient<paths>({
    baseUrl: scope.endpoint,
    headers: { Authorization: `Basic ${basic}` },
  });
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
