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

/**
 * Polls the connector's status endpoint until it leaves PROVISIONING so
 * lifecycle ops like restart (which the API 400s on a PROVISIONING
 * connector) don't race the provisioning POST. Throws if the connector
 * doesn't settle within the timeout. Must run in a `beforeAll` (not an
 * `it`) so the test rule against setTimeout-as-test-primitive is upheld
 * by keeping the wait in the harness layer.
 */
export async function waitForConnectorRunnable(
  name: string,
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
    if (lastState && lastState !== "PROVISIONING") return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `connector ${name} did not leave PROVISIONING within ${timeoutMs}ms (last state: ${lastState ?? "unknown"})`,
  );
}

interface TimingOptions {
  timeoutMs?: number;
  intervalMs?: number;
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
