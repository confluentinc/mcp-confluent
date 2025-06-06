import { ToolConfig, ToolHandler } from "@src/confluent/tools/base-tools.js";
import { AddTagToTopicHandler } from "@src/confluent/tools/handlers/catalog/add-tags-to-topic.js";
import { CreateTopicTagsHandler } from "@src/confluent/tools/handlers/catalog/create-topic-tags.js";
import { DeleteTagHandler } from "@src/confluent/tools/handlers/catalog/delete-tag.js";
import { ListTagsHandler } from "@src/confluent/tools/handlers/catalog/list-tags.js";
import { RemoveTagFromEntityHandler } from "@src/confluent/tools/handlers/catalog/remove-tag-from-entity.js";
import { ListClustersHandler } from "@src/confluent/tools/handlers/clusters/list-clusters-handler.js";
import { CreateConnectorHandler } from "@src/confluent/tools/handlers/connect/create-connector-handler.js";
import { DeleteConnectorHandler } from "@src/confluent/tools/handlers/connect/delete-connector-handler.js";
import { ListConnectorsHandler } from "@src/confluent/tools/handlers/connect/list-connectors-handler.js";
import { ReadConnectorHandler } from "@src/confluent/tools/handlers/connect/read-connectors-handler.js";
import { ListEnvironmentsHandler } from "@src/confluent/tools/handlers/environments/list-environments-handler.js";
import { ReadEnvironmentHandler } from "@src/confluent/tools/handlers/environments/read-environment-handler.js";
import { CreateFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/create-flink-statement-handler.js";
import { DeleteFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/delete-flink-statement-handler.js";
import { ListFlinkStatementsHandler } from "@src/confluent/tools/handlers/flink/list-flink-statements-handler.js";
import { ReadFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/read-flink-statement-handler.js";
import { AlterTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/alter-topic-config.js";
import { ConsumeKafkaMessagesHandler } from "@src/confluent/tools/handlers/kafka/consume-kafka-messages-handler.js";
import { CreateTopicsHandler } from "@src/confluent/tools/handlers/kafka/create-topics-handler.js";
import { DeleteTopicsHandler } from "@src/confluent/tools/handlers/kafka/delete-topics-handler.js";
import { GetTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/get-topic-config.js";
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import { ProduceKafkaMessageHandler } from "@src/confluent/tools/handlers/kafka/produce-kafka-message-handler.js";
import { ListSchemasHandler } from "@src/confluent/tools/handlers/schema/list-schemas-handler.js";
import { SearchTopicsByTagHandler } from "@src/confluent/tools/handlers/search/search-topic-by-tag-handler.js";
import { SearchTopicsByNameHandler } from "@src/confluent/tools/handlers/search/search-topics-by-name-handler.js";
import { CreateTableFlowCatalogIntegrationHandler } from "@src/confluent/tools/handlers/tableflow/catalog/create-tableflow-catalog-integration-handler.js";
import { DeleteTableFlowCatalogIntegrationHandler } from "@src/confluent/tools/handlers/tableflow/catalog/delete-tableflow-catalog-integration-handler.js";
import { ListTableFlowCatalogIntegrationsHandler } from "@src/confluent/tools/handlers/tableflow/catalog/list-tableflow-catalog-integrations-handler.js";
import { ReadTableFlowCatalogIntegrationHandler } from "@src/confluent/tools/handlers/tableflow/catalog/read-tableflow-catalog-integration-handler.js";
import { UpdateTableFlowCatalogIntegrationHandler } from "@src/confluent/tools/handlers/tableflow/catalog/update-tableflow-catalog-integration-handler.js";
import { ListTableFlowRegionsHandler } from "@src/confluent/tools/handlers/tableflow/list-tableflow-regions-handler.js";
import { CreateTableFlowTopicHandler } from "@src/confluent/tools/handlers/tableflow/topic/create-tableflow-topic-handler.js";
import { DeleteTableFlowTopicHandler } from "@src/confluent/tools/handlers/tableflow/topic/delete-tableflow-topic-handler.js";
import { ListTableFlowTopicsHandler } from "@src/confluent/tools/handlers/tableflow/topic/list-tableflow-topics-handler.js";
import { ReadTableFlowTopicHandler } from "@src/confluent/tools/handlers/tableflow/topic/read-tableflow-topic-handler.js";
import { UpdateTableFlowTopicHandler } from "@src/confluent/tools/handlers/tableflow/topic/update-tableflow-topic-handler.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";

export class ToolFactory {
  private static handlers: Map<ToolName, ToolHandler> = new Map([
    [ToolName.LIST_TOPICS, new ListTopicsHandler()],
    [ToolName.CREATE_TOPICS, new CreateTopicsHandler()],
    [ToolName.DELETE_TOPICS, new DeleteTopicsHandler()],
    [ToolName.PRODUCE_MESSAGE, new ProduceKafkaMessageHandler()],
    [ToolName.LIST_FLINK_STATEMENTS, new ListFlinkStatementsHandler()],
    [ToolName.CREATE_FLINK_STATEMENT, new CreateFlinkStatementHandler()],
    [ToolName.READ_FLINK_STATEMENT, new ReadFlinkStatementHandler()],
    [ToolName.DELETE_FLINK_STATEMENTS, new DeleteFlinkStatementHandler()],
    [ToolName.LIST_CONNECTORS, new ListConnectorsHandler()],
    [ToolName.READ_CONNECTOR, new ReadConnectorHandler()],
    [ToolName.CREATE_CONNECTOR, new CreateConnectorHandler()],
    [ToolName.SEARCH_TOPICS_BY_TAG, new SearchTopicsByTagHandler()],
    [ToolName.CREATE_TOPIC_TAGS, new CreateTopicTagsHandler()],
    [ToolName.DELETE_TAG, new DeleteTagHandler()],
    [ToolName.REMOVE_TAG_FROM_ENTITY, new RemoveTagFromEntityHandler()],
    [ToolName.ADD_TAGS_TO_TOPIC, new AddTagToTopicHandler()],
    [ToolName.LIST_TAGS, new ListTagsHandler()],
    [ToolName.ALTER_TOPIC_CONFIG, new AlterTopicConfigHandler()],
    [ToolName.DELETE_CONNECTOR, new DeleteConnectorHandler()],
    [ToolName.SEARCH_TOPICS_BY_NAME, new SearchTopicsByNameHandler()],
    [ToolName.LIST_CLUSTERS, new ListClustersHandler()],
    [ToolName.LIST_ENVIRONMENTS, new ListEnvironmentsHandler()],
    [ToolName.READ_ENVIRONMENT, new ReadEnvironmentHandler()],
    [ToolName.LIST_SCHEMAS, new ListSchemasHandler()],
    [ToolName.CONSUME_MESSAGES, new ConsumeKafkaMessagesHandler()],
    [ToolName.GET_TOPIC_CONFIG, new GetTopicConfigHandler()],
    [ToolName.CREATE_TABLEFLOW_TOPIC, new CreateTableFlowTopicHandler()],
    [ToolName.LIST_TABLEFLOW_REGIONS, new ListTableFlowRegionsHandler()],
    [ToolName.LIST_TABLEFLOW_TOPICS, new ListTableFlowTopicsHandler()],
    [ToolName.READ_TABLEFLOW_TOPIC, new ReadTableFlowTopicHandler()],
    [ToolName.UPDATE_TABLEFLOW_TOPIC, new UpdateTableFlowTopicHandler()],
    [ToolName.DELETE_TABLEFLOW_TOPIC, new DeleteTableFlowTopicHandler()],
    [
      ToolName.CREATE_TABLEFLOW_CATALOG_INTEGRATION,
      new CreateTableFlowCatalogIntegrationHandler(),
    ],
    [
      ToolName.READ_TABLEFLOW_CATALOG_INTEGRATION,
      new ReadTableFlowCatalogIntegrationHandler(),
    ],
    [
      ToolName.LIST_TABLEFLOW_CATALOG_INTEGRATIONS,
      new ListTableFlowCatalogIntegrationsHandler(),
    ],
    [
      ToolName.UPDATE_TABLEFLOW_CATALOG_INTEGRATION,
      new UpdateTableFlowCatalogIntegrationHandler(),
    ],
    [
      ToolName.DELETE_TABLEFLOW_CATALOG_INTEGRATION,
      new DeleteTableFlowCatalogIntegrationHandler(),
    ],
  ]);

  static createToolHandler(toolName: ToolName): ToolHandler {
    if (!this.handlers.has(toolName)) {
      throw new Error(`Unknown tool name: ${toolName}`);
    }
    return this.handlers.get(toolName)!;
  }

  static getToolConfigs(): ToolConfig[] {
    // iterate through all the handlers and collect their configurations
    return Array.from(this.handlers.values()).map((handler) =>
      handler.getToolConfig(),
    );
  }

  static getToolConfig(toolName: ToolName): ToolConfig {
    if (!this.handlers.has(toolName)) {
      throw new Error(`Unknown tool name: ${toolName}`);
    }
    return this.handlers.get(toolName)!.getToolConfig();
  }
}
