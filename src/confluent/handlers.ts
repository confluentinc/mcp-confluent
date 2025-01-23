import { KafkaJS } from "@confluentinc/kafka-javascript/index.js";
import type { paths } from "@src/confluent/openapi-schema";
import { Client, wrapAsPathBasedClient } from "openapi-fetch";

const createResponse = (message: string) => ({
  content: [
    {
      type: "text",
      text: message,
    },
  ],
});
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
  orgId: string,
  envId: string,
  computePoolId: string | undefined,
  pageSize: number = 10,
  pageToken: string | undefined,
  labelSelector: string | undefined,
) {
  const pathBasedClient = wrapAsPathBasedClient(confluentCloudRestClient);
  const { data: response, error } = await pathBasedClient[
    "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements"
  ].GET({
    params: {
      path: {
        organization_id: orgId,
        environment_id: envId,
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
  const formattedSqlStatements = response?.data.map((statement) => {
    return {
      name: statement.name,
      orgId: statement.organization_id,
      envId: statement.environment_id,
      properties: statement.spec.properties,
      statement: statement.spec.statement,
    };
  });
  return createResponse(
    `Flink SQL statements: ${JSON.stringify(formattedSqlStatements)}`,
  );
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
  orgId: string,
  envId: string,
  computePoolId: string | undefined,
  statement: string | undefined,
  statementName: string,
  catalogName: string,
  kafkaClusterName: string,
) {
  const pathBasedClient = wrapAsPathBasedClient(confluentCloudRestClient);
  const { data: response, error } = await pathBasedClient[
    "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements"
  ].POST({
    params: {
      path: {
        environment_id: envId,
        organization_id: orgId,
      },
    },
    body: {
      name: statementName,
      organization_id: orgId,
      environment_id: envId,
      spec: {
        compute_pool_id: computePoolId,
        statement: statement,
        properties: {
          "sql.current-catalog": catalogName,
          "sql.current-database": kafkaClusterName,
        },
      },
    },
  });
  if (error) {
    return createResponse(
      `Failed to create Flink SQL statements: ${JSON.stringify(error)}`,
    );
  }
  return createResponse(
    `Flink SQL Statement Creation Status: ${JSON.stringify(response?.status)}`,
  );
}

/**
 * Retrieves and processes results from a Flink SQL statement execution.
 *
 * @param confluentCloudRestClient - The REST client for Confluent Cloud API interactions
 * @param orgId - The organization ID
 * @param envId - The environment ID
 * @param statementName - The name of the Flink SQL statement
 *
 * @returns A promise that resolves to an object containing the results in a text format
 * @throws {Error} If the API request to read the Flink SQL statement fails
 *
 * @remarks
 * The function implements pagination with a 5-second timeout. It will continue to fetch results
 * using the next page token until either there are no more results or the timeout is reached.
 *
 */
export async function handleReadFlinkStatement(
  confluentCloudRestClient: Client<paths, `${string}/${string}`>,
  orgId: string,
  envId: string,
  statementName: string,
) {
  const pathBasedClient = wrapAsPathBasedClient(confluentCloudRestClient);
  let allResults: unknown[] = [];
  let nextToken: string | undefined = undefined;
  const timeout = Date.now() + 5000; // 5 seconds

  do {
    const { data: response, error } = await pathBasedClient[
      "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{name}/results"
    ].GET({
      params: {
        path: {
          organization_id: orgId,
          environment_id: envId,
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
  } while (nextToken && Date.now() < timeout);

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
  orgId: string,
  envId: string,
  statementName: string,
) {
  const pathBasedClient = wrapAsPathBasedClient(confluentCloudRestClient);
  const { response, error } = await pathBasedClient[
    "/sql/v1/organizations/{organization_id}/environments/{environment_id}/statements/{statement_name}"
  ].DELETE({
    params: {
      path: {
        organization_id: orgId,
        environment_id: envId,
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
  envId: string,
  clusterId: string,
) {
  const pathBasedClient = wrapAsPathBasedClient(confluentCloudRestClient);
  const { data: response, error } = await pathBasedClient[
    "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors"
  ].GET({
    params: {
      path: {
        environment_id: envId,
        kafka_cluster_id: clusterId,
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
  envId: string,
  clusterId: string,
  connectorName: string,
) {
  const pathBasedClient = wrapAsPathBasedClient(confluentCloudRestClient);
  const { data: response, error } = await pathBasedClient[
    "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connectors/{connector_name}"
  ].GET({
    params: {
      path: {
        connector_name: connectorName,
        environment_id: envId,
        kafka_cluster_id: clusterId,
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

/**
 * Get the required configuration for a connector plugin.
 *
 */
export async function handleGetConnectorConfig(
  confluentCloudRestClient: Client<paths, `${string}/${string}`>,
  envId: string,
  clusterId: string,
  pluginName: string,
) {
  const pathBasedClient = wrapAsPathBasedClient(confluentCloudRestClient);
  const { data: response, error } = await pathBasedClient[
    "/connect/v1/environments/{environment_id}/clusters/{kafka_cluster_id}/connector-plugins/{plugin_name}/config/validate"
  ].PUT({
    params: {
      path: {
        environment_id: envId,
        kafka_cluster_id: clusterId,
        plugin_name: pluginName,
      },
    },
    body: {},
  });
  if (error) {
    return createResponse(
      `Failed to get connector config: ${JSON.stringify(error)}`,
    );
  }
  const formattedValidationResponse = response?.configs?.map((config) => {
    return {
      name: config.definition?.name,
      type: config.definition?.type,
      required: config.definition?.required,
      default_value: config.definition?.default_value,
      importance: config.definition?.importance,
      documentation: config.definition?.documentation,
      group: config.definition?.group,
      dependents: config.definition?.dependents,
      recommended_values: config.value?.recommended_values,
    };
  });

  return createResponse(
    `Configuration properties for ${pluginName}: ${JSON.stringify(formattedValidationResponse)}`,
  );
}
