import type { paths } from "@src/confluent/openapi-schema.js";
import type { Client } from "openapi-fetch";

export type CloudClient = Client<paths, `${string}/${string}`>;

export async function resolveKafkaBootstrap(
  cloudClient: CloudClient,
  clusterId: string,
  envId: string,
): Promise<string> {
  const { data, error } = await cloudClient.GET("/cmk/v2/clusters/{id}", {
    params: { path: { id: clusterId }, query: { environment: envId } },
  });
  if (error !== undefined) {
    throw new Error(
      `Failed to read Kafka cluster ${clusterId} in environment ${envId}: ${JSON.stringify(error)}`,
    );
  }
  const bootstrap = data?.spec?.kafka_bootstrap_endpoint;
  if (typeof bootstrap !== "string" || bootstrap.length === 0) {
    throw new Error(
      `Cluster ${clusterId} in environment ${envId} has no kafka_bootstrap_endpoint`,
    );
  }
  return bootstrap;
}

export async function resolveKafkaRestEndpoint(
  cloudClient: CloudClient,
  clusterId: string,
  envId: string,
): Promise<string> {
  const { data, error } = await cloudClient.GET("/cmk/v2/clusters/{id}", {
    params: { path: { id: clusterId }, query: { environment: envId } },
  });
  if (error !== undefined) {
    throw new Error(
      `Failed to read Kafka cluster ${clusterId} in environment ${envId}: ${JSON.stringify(error)}`,
    );
  }
  const httpEndpoint = data?.spec?.http_endpoint;
  if (typeof httpEndpoint !== "string" || httpEndpoint.length === 0) {
    throw new Error(
      `Cluster ${clusterId} in environment ${envId} has no http_endpoint`,
    );
  }
  return httpEndpoint;
}

export async function resolveSchemaRegistryEndpoint(
  cloudClient: CloudClient,
  clusterId: string,
  envId: string,
): Promise<string> {
  const { data, error } = await cloudClient.GET("/srcm/v3/clusters/{id}", {
    params: { path: { id: clusterId }, query: { environment: envId } },
  });
  if (error !== undefined) {
    throw new Error(
      `Failed to read Schema Registry cluster ${clusterId} in environment ${envId}: ${JSON.stringify(error)}`,
    );
  }
  const httpEndpoint = data?.spec?.http_endpoint;
  if (typeof httpEndpoint !== "string" || httpEndpoint.length === 0) {
    throw new Error(
      `Schema Registry cluster ${clusterId} in environment ${envId} has no http_endpoint`,
    );
  }
  return httpEndpoint;
}

export async function resolveSchemaRegistryClusterId(
  cloudClient: CloudClient,
  envId: string,
): Promise<string> {
  const { data, error } = await cloudClient.GET("/srcm/v3/clusters", {
    params: { query: { environment: envId } },
  });
  if (error !== undefined) {
    throw new Error(
      `Failed to list Schema Registry clusters in environment ${envId}: ${JSON.stringify(error)}`,
    );
  }
  const clusters = data?.data ?? [];
  if (clusters.length === 0) {
    throw new Error(
      `No Schema Registry cluster found in environment ${envId}. ` +
        `Schema Registry must be enabled on the environment in Confluent Cloud.`,
    );
  }
  if (clusters.length > 1) {
    // Defensive: CCloud's documented invariant is one SR per environment.
    // If that ever changes, callers will need to pick a specific cluster
    // rather than have us silently take the first.
    throw new Error(
      `Multiple Schema Registry clusters found in environment ${envId} (count: ${clusters.length}). ` +
        `Single SR per environment is assumed; multi-SR is not supported.`,
    );
  }
  const id = clusters[0]?.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(
      `Schema Registry cluster in environment ${envId} has no id`,
    );
  }
  return id;
}
