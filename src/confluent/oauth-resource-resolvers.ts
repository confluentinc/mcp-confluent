import type { paths } from "@src/confluent/openapi-schema.js";
import type { Client } from "openapi-fetch";

type CloudClient = Client<paths, `${string}/${string}`>;

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
