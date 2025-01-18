import { KafkaJS } from "@confluentinc/kafka-javascript/index.js";
import { createResponse, getEnsuredParam } from "@src/confluent/helpers.js";
import type { paths } from "@src/confluent/openapi-schema";
import env from "@src/env.js";
import { Client, wrapAsPathBasedClient } from "openapi-fetch";

/**
 * Handles the listing of Kafka topics using the provided KafkaJS Admin client.
 *
 * @param kafkaAdminClient - The KafkaJS Admin client used to list topics.
 * @returns An object containing a content array with a message listing the Kafka topics.
 */
export async function handleListTopics(kafkaAdminClient: KafkaJS.Admin) {
  const topics = await kafkaAdminClient.listTopics();
  return createResponse(`Kafka topics: ${topics.join(",")}`);
}

/**
 * Handles the creation of Kafka topics using the provided KafkaJS Admin client.
 *
 * @param kafkaAdminClient - The KafkaJS Admin client used to create topics.
 * @param topicNames - An array of topic names to be created.
 * @returns An object containing a content array with a message indicating the result of the topic creation.
 */
export async function handleCreateTopics(
  kafkaAdminClient: KafkaJS.Admin,
  topicNames: string[],
) {
  const success = await kafkaAdminClient.createTopics({
    topics: topicNames.map((name) => ({ topic: name })),
  });
  if (!success) {
    return createResponse(
      `Failed to create Kafka topics: ${topicNames.join(",")}`,
    );
  }
  return createResponse(`Created Kafka topics: ${topicNames.join(",")}`);
}

/**
 * Handles the deletion of Kafka topics using the provided KafkaJS Admin client.
 *
 * @param kafkaAdminClient - The KafkaJS Admin client instance used to delete topics.
 * @param topicNames - An array of topic names to be deleted.
 * @returns A promise that resolves to an object containing a content array with a text message indicating the result of the deletion operation.
 *          If successful, the message will list the deleted topics.
 *          If an error occurs, the message will include the error details.
 */
export async function handleDeleteTopics(
  kafkaAdminClient: KafkaJS.Admin,
  topicNames: string[],
) {
  await kafkaAdminClient.deleteTopics({ topics: topicNames });
  return createResponse(`Deleted Kafka topics: ${topicNames.join(",")}`);
}

/**
 * Handles producing a message to a Kafka topic using the provided Kafka producer.
 *
 * @param kafkaProducer - The Kafka producer instance to use for sending the message.
 * @param topic - The Kafka topic to which the message should be produced.
 * @param message - The message to be produced to the Kafka topic.
 * @returns A promise that resolves to an object containing a content array with a text message indicating the result of the produce operation.
 */
export async function handleProduceMessage(
  kafkaProducer: KafkaJS.Producer,
  topic: string,
  message: string,
) {
  await kafkaProducer.send({ topic, messages: [{ value: message }] });
  return createResponse(`Produced message to Kafka topic: ${topic}`);
}

/**
 * Handles the listing of Flink SQL statements.
 *
 * @param confluentCloudRestClient - The Confluent Cloud REST client.
 * @param orgId - The organization ID.
 * @param envId - The environment ID.
 * @param computePoolId - The compute pool ID.
 * @param pageSize - The number of statements to retrieve per page.
 * @param pageToken - The token for the page of results to retrieve.
 * @param labelSelector - The label selector to filter statements.
 * @returns An object containing the formatted Flink SQL statements.
 * @throws Will throw an error if the request to list Flink SQL statements fails.
 */
export async function handleListFlinkStatements(
  confluentCloudRestClient: Client<paths, `${string}/${string}`>,
  orgId: string | undefined,
  envId: string | undefined,
  computePoolId: string | undefined = env["FLINK_COMPUTE_POOL_ID"],
  pageSize: number = 10,
  pageToken: string | undefined,
  labelSelector: string | undefined,
) {
  const organization_id = getEnsuredParam(
    "FLINK_ORG_ID",
    "Organization ID is required",
    orgId,
  );
  const environment_id = getEnsuredParam(
    "FLINK_ENV_ID",
    "Environment ID is required",
    envId,
  );

  const pathBasedClient = wrapAsPathBasedClient(confluentCloudRestClient);
  const { data: response, error } = await pathBasedClient[
    "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements"
  ].GET({
    params: {
      path: {
        organization_id: organization_id,
        environment_id: environment_id,
      },
      query: {
        compute_pool_id: computePoolId,
        page_size: pageSize,
        page_token: pageToken,
        label_selector: labelSelector,
      },
    },
  });
  if (error) {
    return createResponse(
      `Failed to list Flink SQL statements: ${JSON.stringify(error)}`,
    );
  }
  return createResponse(`${JSON.stringify(response)}`);
}

/**
 * Creates a Flink SQL statement in Confluent Cloud.
 *
 * @param confluentCloudRestClient - The Confluent Cloud REST API client
 * @param orgId - The organization ID
 * @param envId - The environment ID
 * @param computePoolId - The compute pool ID where the statement will be executed
 * @param statement - The Flink SQL statement to be created
 * @param statementName - The name of the statement
 * @param catalogName - The catalog name to be used for the statement. Typically the confluent environment name
 * @param kafkaClusterName - The Kafka cluster name to be used as the current database
 *
 * @returns A promise that resolves to an object containing the statement creation status
 * @throws Error if the statement creation fails
 */
export async function handleCreateFlinkStatement(
  confluentCloudRestClient: Client<paths, `${string}/${string}`>,
  orgId: string | undefined,
  envId: string | undefined,
  computePoolId: string | undefined = env["FLINK_COMPUTE_POOL_ID"],
  statement: string | undefined,
  statementName: string,
  catalogName: string | undefined = env["FLINK_ENV_NAME"],
  kafkaClusterName: string | undefined = env["KAFKA_CLUSTER_ID"],
) {
  const organization_id = getEnsuredParam(
    "FLINK_ORG_ID",
    "Organization ID is required",
    orgId,
  );
  const environment_id = getEnsuredParam(
    "FLINK_ENV_ID",
    "Environment ID is required",
    envId,
  );

  const pathBasedClient = wrapAsPathBasedClient(confluentCloudRestClient);
  const { data: response, error } = await pathBasedClient[
    "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements"
  ].POST({
    params: {
      path: {
        environment_id: environment_id,
        organization_id: organization_id,
      },
    },
    body: {
      name: statementName,
      organization_id: organization_id,
      environment_id: environment_id,
      spec: {
        compute_pool_id: computePoolId,
        statement: statement,
        properties: {
          // only include the catalog and database properties if they are defined
          ...(catalogName && { "sql.current-catalog": catalogName }),
          ...(kafkaClusterName && { "sql.current-database": kafkaClusterName }),
        },
      },
    },
  });
  if (error) {
    return createResponse(
      `Failed to create Flink SQL statements: ${JSON.stringify(error)}`,
    );
  }
  return createResponse(`${JSON.stringify(response)}`);
}

/**
 * Retrieves and processes results from a Flink SQL statement execution.
 *
 * @param confluentCloudRestClient - The REST client for Confluent Cloud API interactions
 * @param orgId - The organization ID
 * @param envId - The environment ID
 * @param statementName - The name of the Flink SQL statement
 * @param timeoutInMilliseconds - The timeout in milliseconds for fetching results. Set to -1 to disable timeout and rely on the api's next page token to stop fetching results.
 *
 * @returns A promise that resolves to an object containing the results in a text format
 * @throws {Error} If the API request to read the Flink SQL statement fails
 *
 * @remarks
 * The function implements pagination. It will continue to fetch results
 * using the next page token until either there are no more results or the timeout is reached.
 * Tables backed by kafka topics can be thought of as never-ending streams as data could be continuously
 * produced in near real-time. Therefore, if you wish to sample values from a stream, you may want to set a timeout.
 *
 */
export async function handleReadFlinkStatement(
  confluentCloudRestClient: Client<paths, `${string}/${string}`>,
  orgId: string | undefined,
  envId: string | undefined,
  statementName: string,
  timeoutInMilliseconds: number | undefined = 5000,
) {
  const organization_id = getEnsuredParam(
    "FLINK_ORG_ID",
    "Organization ID is required",
    orgId,
  );
  const environment_id = getEnsuredParam(
    "FLINK_ENV_ID",
    "Environment ID is required",
    envId,
  );

  const pathBasedClient = wrapAsPathBasedClient(confluentCloudRestClient);
  let allResults: unknown[] = [];
  let nextToken: string | undefined = undefined;
  const timeout =
    timeoutInMilliseconds === -1 || timeoutInMilliseconds === undefined
      ? undefined
      : Date.now() + timeoutInMilliseconds;

  /**
   * A timeout period has elapsed if a timeout is defined and the current time has exceeded it,
   * `false` otherwise.
   */
  const hasTimedOut = () => timeout !== undefined && Date.now() >= timeout;

  do {
    const { data: response, error } = await pathBasedClient[
      "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{name}/results"
    ].GET({
      params: {
        path: {
          organization_id: organization_id,
          environment_id: environment_id,
          name: statementName,
        },
        // only include the page token if it's defined
        ...(nextToken ? { query: { page_token: nextToken } } : {}),
      },
    });

    if (error) {
      return createResponse(
        `Failed to read Flink SQL statement: ${JSON.stringify(error)}`,
      );
    }

    allResults = allResults.concat(response?.results.data || []);
    nextToken = response?.metadata.next?.split("page_token=")[1];
  } while (nextToken && !hasTimedOut());

  return createResponse(
    `Flink SQL Statement Results: ${JSON.stringify(allResults)}`,
  );
}

/**
 * Deletes a Flink SQL statement from Confluent Cloud.
 *
 * @param confluentCloudRestClient - The Confluent Cloud REST API client instance
 * @param orgId - The organization ID where the statement exists
 * @param envId - The environment ID where the statement exists
 * @param statementName - The name of the statement to delete
 * @returns An object containing content array with deletion status message
 * @throws {Error} When the deletion request fails
 *
 */
export async function handleDeleteFlinkStatement(
  confluentCloudRestClient: Client<paths, `${string}/${string}`>,
  orgId: string | undefined,
  envId: string | undefined,
  statementName: string,
) {
  const organization_id = getEnsuredParam(
    "FLINK_ORG_ID",
    "Organization ID is required",
    orgId,
  );
  const environment_id = getEnsuredParam(
    "FLINK_ENV_ID",
    "Environment ID is required",
    envId,
  );
  const pathBasedClient = wrapAsPathBasedClient(confluentCloudRestClient);
  const { response, error } = await pathBasedClient[
    "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{statement_name}"
  ].DELETE({
    params: {
      path: {
        organization_id: organization_id,
        environment_id: environment_id,
        statement_name: statementName,
      },
    },
  });
  if (error) {
    return createResponse(
      `Failed to delete Flink SQL statement: ${JSON.stringify(error)}`,
    );
  }
  return createResponse(
    `Flink SQL Statement Deletion Status Code: ${response?.status}`,
  );
}

/**
 * Lists Confluent Cloud connectors for a given cluster.
 *
 * @param confluentCloudRestClient - The Confluent Cloud REST API client instance
 * @param envId - The Confluent Cloud environment ID
 * @param clusterId - The Confluent Cloud cluster ID
 * @returns An object containing a content array with a message listing the active connectors
 * @throws {Error} if the request to list Confluent Cloud connectors fails
 */
export async function handleListConnectors(
  confluentCloudRestClient: Client<paths, `${string}/${string}`>,
  envId: string | undefined,
  clusterId: string | undefined,
) {
  const environment_id = getEnsuredParam(
    "FLINK_ENV_ID",
    "Environment ID is required",
    envId,
  );
  const kafka_cluster_id = getEnsuredParam(
    "KAFKA_CLUSTER_ID",
    "Kafka Cluster ID is required",
    clusterId,
  );

  const pathBasedClient = wrapAsPathBasedClient(confluentCloudRestClient);
  const { data: response, error } = await pathBasedClient[
    "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors"
  ].GET({
    params: {
      path: {
        environment_id: environment_id,
        kafka_cluster_id: kafka_cluster_id,
      },
    },
  });
  if (error) {
    return createResponse(
      `Failed to list Confluent Cloud connectors for ${clusterId}: ${JSON.stringify(error)}`,
    );
  }
  return createResponse(
    `Active Connectors: ${JSON.stringify(response?.join(","))}`,
  );
}

/**
 * Gets the configuration details for a given connector
 *
 * @param confluentCloudRestClient - The Confluent Cloud REST API client instance
 * @param envId - The Confluent Cloud environment ID
 * @param clusterId - The Confluent Cloud cluster ID
 * @param connectorName - The name of the connector
 * @returns An object containing the connector details
 * @throws {Error} if the request to get the connector details fails
 */
export async function handleReadConnector(
  confluentCloudRestClient: Client<paths, `${string}/${string}`>,
  envId: string | undefined,
  clusterId: string | undefined,
  connectorName: string,
) {
  const environment_id = getEnsuredParam(
    "FLINK_ENV_ID",
    "Environment ID is required",
    envId,
  );
  const kafka_cluster_id = getEnsuredParam(
    "KAFKA_CLUSTER_ID",
    "Kafka Cluster ID is required",
    clusterId,
  );

  const pathBasedClient = wrapAsPathBasedClient(confluentCloudRestClient);
  const { data: response, error } = await pathBasedClient[
    "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}"
  ].GET({
    params: {
      path: {
        connector_name: connectorName,
        environment_id: environment_id,
        kafka_cluster_id: kafka_cluster_id,
      },
    },
  });
  if (error) {
    return createResponse(
      `Failed to get information about connector ${connectorName}: ${JSON.stringify(error)}`,
    );
  }
  return createResponse(
    `Connector Details for ${connectorName}: ${JSON.stringify(response)}`,
  );
}
