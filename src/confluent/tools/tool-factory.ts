import { ToolConfig, ToolHandler } from "@src/confluent/tools/base-tools.js";
import { AddTagToTopicHandler } from "@src/confluent/tools/handlers/catalog/add-tags-to-topic.js";
import { CreateTopicTagsHandler } from "@src/confluent/tools/handlers/catalog/create-topic-tags.js";
import { DeleteTagHandler } from "@src/confluent/tools/handlers/catalog/delete-tag.js";
import { ListTagsHandler } from "@src/confluent/tools/handlers/catalog/list-tags.js";
import { RemoveTagFromEntityHandler } from "@src/confluent/tools/handlers/catalog/remove-tag-from-entity.js";
import { CreateConnectorHandler } from "@src/confluent/tools/handlers/connect/create-connector-handler.js";
import { ListConnectorsHandler } from "@src/confluent/tools/handlers/connect/list-connectors-handler.js";
import { ReadConnectorHandler } from "@src/confluent/tools/handlers/connect/read-connectors-handler.js";
import { CreateFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/create-flink-statement-handler.js";
import { DeleteFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/delete-flink-statement-handler.js";
import { ListFlinkStatementsHandler } from "@src/confluent/tools/handlers/flink/list-flink-statements-handler.js";
import { ReadFlinkStatementHandler } from "@src/confluent/tools/handlers/flink/read-flink-statement-handler.js";
import { AlterTopicConfigHandler } from "@src/confluent/tools/handlers/kafka/alter-topic-config.js";
import { CreateTopicsHandler } from "@src/confluent/tools/handlers/kafka/create-topics-handler.js";
import { DeleteTopicsHandler } from "@src/confluent/tools/handlers/kafka/delete-topics-handler.js";
import { ListTopicsHandler } from "@src/confluent/tools/handlers/kafka/list-topics-handler.js";
import { ProduceKafkaMessageHandler } from "@src/confluent/tools/handlers/kafka/produce-kafka-message-handler.js";
import { SearchTopicsByTagHandler } from "@src/confluent/tools/handlers/search/search-topic-by-tag-handler.js";
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
