export enum ToolName {
  LIST_TOPICS = "list-topics",
  CREATE_TOPICS = "create-topics",
  DELETE_TOPICS = "delete-topics",
  PRODUCE_MESSAGE = "produce-message",
  CONSUME_MESSAGES = "consume-messages",
  GET_PARTITION_OFFSETS = "get-partition-offsets",
  LIST_CONSUMER_GROUPS = "list-consumer-groups",
  DESCRIBE_CONSUMER_GROUP = "describe-consumer-group",
  GET_CONSUMER_GROUP_LAG = "get-consumer-group-lag",
  LIST_FLINK_STATEMENTS = "list-flink-statements",
  CREATE_FLINK_STATEMENT = "create-flink-statement",
  READ_FLINK_STATEMENT = "read-flink-statement",
  DELETE_FLINK_STATEMENTS = "delete-flink-statements",
  GET_FLINK_STATEMENT_EXCEPTIONS = "get-flink-statement-exceptions",
  LIST_FLINK_CATALOGS = "list-flink-catalogs",
  LIST_FLINK_DATABASES = "list-flink-databases",
  LIST_FLINK_TABLES = "list-flink-tables",
  DESCRIBE_FLINK_TABLE = "describe-flink-table",
  GET_FLINK_TABLE_INFO = "get-flink-table-info",
  CHECK_FLINK_STATEMENT_HEALTH = "check-flink-statement-health",
  DETECT_FLINK_STATEMENT_ISSUES = "detect-flink-statement-issues",
  GET_FLINK_STATEMENT_PROFILE = "get-flink-statement-profile",
  LIST_CONNECTORS = "list-connectors",
  CREATE_CONNECTOR = "create-connector",
  DELETE_CONNECTOR = "delete-connector",
  GET_CONNECTOR_CONFIG = "get-connector-config",
  GET_CONNECTOR_OFFSETS = "get-connector-offsets",
  GET_CONNECTOR_STATUS = "get-connector-status",
  GET_CONNECTOR_TASKS = "get-connector-tasks",
  GET_CONNECTOR_ERROR_SUMMARY = "get-connector-error-summary",
  GET_CONNECTOR_ERROR_RECOMMENDATIONS = "get-connector-error-recommendations",
  GET_CONNECTOR_LOGS = "get-connector-logs",
  UPDATE_CONNECTOR_CONFIG = "update-connector-config",
  PAUSE_CONNECTOR = "pause-connector",
  RESUME_CONNECTOR = "resume-connector",
  RESTART_CONNECTOR = "restart-connector",
  SEARCH_TOPICS_BY_TAG = "search-topics-by-tag",
  SEARCH_TOPICS_BY_NAME = "search-topics-by-name",
  CREATE_TOPIC_TAGS = "create-topic-tags",
  DELETE_TAG = "delete-tag",
  REMOVE_TAG_FROM_ENTITY = "remove-tag-from-entity",
  ADD_TAGS_TO_TOPIC = "add-tags-to-topic",
  LIST_TAGS = "list-tags",
  ALTER_TOPIC_CONFIG = "alter-topic-config",
  LIST_CLUSTERS = "list-clusters",
  LIST_ENVIRONMENTS = "list-environments",
  READ_ENVIRONMENT = "read-environment",
  LIST_SCHEMAS = "list-schemas",
  DELETE_SCHEMA = "delete-schema",
  GET_TOPIC_CONFIG = "get-topic-config",
  CREATE_TABLEFLOW_TOPIC = "create-tableflow-topic",
  LIST_TABLEFLOW_REGIONS = "list-tableflow-regions",
  LIST_TABLEFLOW_TOPICS = "list-tableflow-topics",
  READ_TABLEFLOW_TOPIC = "read-tableflow-topic",
  UPDATE_TABLEFLOW_TOPIC = "update-tableflow-topic",
  DELETE_TABLEFLOW_TOPIC = "delete-tableflow-topic",
  CREATE_TABLEFLOW_CATALOG_INTEGRATION = "create-tableflow-catalog-integration",
  LIST_TABLEFLOW_CATALOG_INTEGRATIONS = "list-tableflow-catalog-integrations",
  READ_TABLEFLOW_CATALOG_INTEGRATION = "read-tableflow-catalog-integration",
  UPDATE_TABLEFLOW_CATALOG_INTEGRATION = "update-tableflow-catalog-integration",
  DELETE_TABLEFLOW_CATALOG_INTEGRATION = "delete-tableflow-catalog-integration",
  LIST_BILLING_COSTS = "list-billing-costs",
  QUERY_METRICS = "query-metrics",
  LIST_METRICS = "list-available-metrics",
  SEARCH_PRODUCT_DOCS = "search-product-docs",
  GET_PRODUCT_DOC_PAGE = "get-product-doc-page",
  LIST_ORGANIZATIONS = "list-organizations",
  EXPLAIN_DISABLED_TOOLS = "explain-disabled-tools",
  LIST_CONFIGURED_CONNECTIONS = "list-configured-connections",
}

/**
 * The curated set of tools advertised when the operator configures no
 * allow/block-list. A 69-tool surface dilutes the assistant's tool selection
 * and overwhelms first-time users, so the no-filter default is this 10-tool
 * "discovery + core" set rather than the entire {@link ToolName} enum.
 *
 * This is an upper bound: the effective set is intersected with each tool's
 * connection predicate, so a tool here still won't be advertised if its
 * service block is absent (e.g. {@link ToolName.CREATE_FLINK_STATEMENT} needs
 * a `flink:` block). {@link ToolName.SEARCH_PRODUCT_DOCS} and
 * {@link ToolName.EXPLAIN_DISABLED_TOOLS} are always enabled, so the server
 * can never end up advertising zero tools.
 *
 * Operators widen this with `--allow-tools` (replaces the default with an
 * explicit set) or `--block-tools` (starts from the full catalog minus the
 * blocked tools). `explain-disabled-tools` lists what is off by default and
 * how to enable it.
 */
export const DEFAULT_ENABLED_TOOLS: readonly ToolName[] = [
  ToolName.LIST_ENVIRONMENTS,
  ToolName.LIST_CLUSTERS,
  ToolName.LIST_TOPICS,
  ToolName.PRODUCE_MESSAGE,
  ToolName.CONSUME_MESSAGES,
  ToolName.LIST_FLINK_STATEMENTS,
  ToolName.CREATE_FLINK_STATEMENT,
  ToolName.LIST_SCHEMAS,
  ToolName.SEARCH_PRODUCT_DOCS,
  ToolName.EXPLAIN_DISABLED_TOOLS,
];
