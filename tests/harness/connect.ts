import { newTestCloudClient } from "@tests/harness/confluent-cloud.js";
import { integrationRuntime } from "@tests/harness/runtime.js";
import { afterAll } from "vitest";

interface ConnectScope {
  envId: string;
  clusterId: string;
  kafkaApiKey: string;
  kafkaApiSecret: string;
}

function getConnectScope(): ConnectScope {
  const conn = integrationRuntime().config.getSoleDirectConnection();
  if (!conn.kafka?.env_id || !conn.kafka.cluster_id || !conn.kafka.auth) {
    throw new Error(
      "test-side connect helpers require kafka.env_id + kafka.cluster_id + kafka.auth in test-fixtures/yaml_configs/integration.yaml",
    );
  }
  return {
    envId: conn.kafka.env_id,
    clusterId: conn.kafka.cluster_id,
    kafkaApiKey: conn.kafka.auth.key,
    kafkaApiSecret: conn.kafka.auth.secret,
  };
}

/**
 * Provisions a managed Datagen Source connector targeting a topic named
 * after the connector itself (CCloud auto-creates the topic). The POST
 * returns immediately with status PROVISIONING; tests don't need to wait
 * for RUNNING since the record is queryable as soon as POST resolves.
 */
export async function provisionTestDatagenConnector(
  name: string,
): Promise<void> {
  const { envId, clusterId, kafkaApiKey, kafkaApiSecret } = getConnectScope();
  const client = newTestCloudClient();
  const { error } = await client.POST(
    "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors",
    {
      params: { path: { environment_id: envId, kafka_cluster_id: clusterId } },
      body: {
        name,
        config: {
          name,
          "connector.class": "DatagenSource",
          "kafka.api.key": kafkaApiKey,
          "kafka.api.secret": kafkaApiSecret,
          "kafka.topic": name,
          quickstart: "USERS",
          "tasks.max": "1",
          "output.data.format": "JSON",
        },
      },
    },
  );
  if (error) {
    throw new Error(
      `failed to provision test connector ${name}: ${JSON.stringify(error)}`,
    );
  }
}

/**
 * DELETE the named connector. Tolerates 404 silently because the delete-connector
 * test deletes via the tool, so teardown's 404 isn't a real failure. Logs other
 * failures to stderr; {@linkcode withSharedConnectorCleanup} uses
 * `Promise.allSettled`, so logging is the only path that surfaces them.
 */
export async function deleteTestConnector(name: string): Promise<void> {
  const { envId, clusterId } = getConnectScope();
  const client = newTestCloudClient();
  const { error, response } = await client.DELETE(
    "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}",
    {
      params: {
        path: {
          environment_id: envId,
          kafka_cluster_id: clusterId,
          connector_name: name,
        },
      },
    },
  );
  if (error && response.status !== 404) {
    console.error(
      `failed to delete test connector ${name} (status ${response.status}): ${JSON.stringify(error)}`,
    );
  }
}

interface TimingOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Polls the connector's status endpoint until `matches(state)` returns true.
 * Throws if the predicate is not satisfied within the timeout. CCloud's
 * lifecycle ops are asynchronous — pause/resume return 202 the moment the
 * request is accepted, not when the state actually transitions — so tests
 * that chain ops (e.g. resume → restart) must wait for the intermediate
 * state to land before issuing the next call. Kept in the harness layer
 * (not a test `it`) so the "no setTimeout-for-waiting in tests" rule
 * stays intact.
 */
export async function waitForConnectorState(
  name: string,
  matches: (state: string | undefined) => boolean,
  description: string,
  { timeoutMs = 60_000, intervalMs = 2_000 }: TimingOptions = {},
): Promise<void> {
  const { envId, clusterId } = getConnectScope();
  const client = newTestCloudClient();
  const deadline = Date.now() + timeoutMs;
  let lastState: string | undefined;
  while (Date.now() < deadline) {
    const { data } = await client.GET(
      "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}/status",
      {
        params: {
          path: {
            environment_id: envId,
            kafka_cluster_id: clusterId,
            connector_name: name,
          },
        },
      },
    );
    lastState = data?.connector?.state;
    if (matches(lastState)) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `connector ${name} did not reach ${description} within ${timeoutMs}ms (last state: ${lastState ?? "unknown"})`,
  );
}

/** Wait for the connector to leave PROVISIONING, i.e. become operable. */
export function waitForConnectorRunnable(
  name: string,
  opts?: TimingOptions,
): Promise<void> {
  return waitForConnectorState(
    name,
    (s) => s !== undefined && s !== "PROVISIONING",
    "a non-PROVISIONING state",
    opts,
  );
}

/** Wait for the connector to reach RUNNING (e.g. after resume, before restart). */
export function waitForConnectorRunning(
  name: string,
  opts?: TimingOptions,
): Promise<void> {
  return waitForConnectorState(name, (s) => s === "RUNNING", "RUNNING", opts);
}

/**
 * Registers an `afterAll` at the calling describe scope to delete any
 * tracked connectors. Tests push names onto `createdConnectors` as they
 * create them; the sweep is best-effort so a teardown failure can't fail
 * an already-asserted test.
 */
export function withSharedConnectorCleanup(): { createdConnectors: string[] } {
  const createdConnectors: string[] = [];
  afterAll(async () => {
    await Promise.allSettled(
      createdConnectors.map((n) => deleteTestConnector(n)),
    );
  });
  return { createdConnectors };
}
