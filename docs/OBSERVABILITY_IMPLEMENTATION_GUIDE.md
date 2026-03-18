# Observability Tools Implementation Guide

This guide outlines how to build comprehensive observability support for the Confluent Cloud MCP server using Confluent's public APIs.

## Architecture Overview

Your MCP server already has the foundation for observability:
- **Telemetry Client**: `getConfluentCloudTelemetryRestClient()` configured in `client-manager.ts:242-254`
- **Metrics API Endpoint**: `https://api.telemetry.confluent.cloud` (configurable via `TELEMETRY_ENDPOINT`)
- **Authentication**: Uses `TELEMETRY_API_KEY`/`TELEMETRY_API_SECRET` or falls back to Cloud API credentials

## Confluent Cloud APIs for Observability

### 1. Metrics API v2 (Telemetry)
- **Endpoint**: `https://api.telemetry.confluent.cloud`
- **Documentation**: https://api.telemetry.confluent.cloud/docs
- **Key Endpoints**:
  - `POST /v2/metrics/{dataset}/query` - Query time-series metrics
  - `GET /v2/metrics/{dataset}/descriptors` - List available metrics

**Datasets Available**:
- `cloud` - Confluent Cloud cluster metrics
- `kafka` - Kafka broker metrics
- `connect` - Connector metrics
- `ksqldb` - ksqlDB metrics

### 2. Cloud API v2 (Resource Management)
- **Endpoint**: `https://api.confluent.cloud`
- Already integrated via `getConfluentCloudRestClient()`

### 3. Kafka REST API v3
- **Endpoint**: Cluster-specific (e.g., `pkc-xxxxx.us-east-1.aws.confluent.cloud`)
- Already integrated via `getConfluentCloudKafkaRestClient()`
- **Consumer Lag**: `GET /kafka/v3/clusters/{cluster_id}/consumer-groups/{group_id}/lag-summary`

## Implementation Roadmap

### Phase 1: Cluster Health & Metrics Tools

#### Tool 1: `get-cluster-metrics`

**Purpose**: Fetch real-time cluster-level telemetry

**Tool Config**:
```typescript
// src/confluent/tools/tool-name.ts
export enum ToolName {
  // ... existing tools
  GET_CLUSTER_METRICS = "get-cluster-metrics",
}
```

**Handler Location**: `src/confluent/tools/handlers/metrics/get-cluster-metrics-handler.ts`

**Input Schema**:
```typescript
const getClusterMetricsArguments = z.object({
  clusterId: z.string()
    .describe("Kafka cluster ID (e.g., lkc-xxxxx)")
    .startsWith("lkc-"),
  metrics: z.array(z.enum([
    "io.confluent.kafka.server/active_connection_count",
    "io.confluent.kafka.server/request_bytes",
    "io.confluent.kafka.server/response_bytes",
    "io.confluent.kafka.server/received_bytes",
    "io.confluent.kafka.server/sent_bytes",
    "io.confluent.kafka.server/retained_bytes",
    "io.confluent.kafka.server/cluster_load_percent",
  ])).default([
    "io.confluent.kafka.server/active_connection_count",
    "io.confluent.kafka.server/request_bytes",
    "io.confluent.kafka.server/response_bytes",
  ]),
  startTime: z.string()
    .datetime()
    .describe("ISO 8601 timestamp for query start")
    .optional(),
  endTime: z.string()
    .datetime()
    .describe("ISO 8601 timestamp for query end")
    .optional(),
  granularity: z.enum(["PT1M", "PT5M", "PT15M", "PT1H"])
    .default("PT5M")
    .describe("Time granularity for aggregation"),
});
```

**API Request Example**:
```typescript
const { data, error } = await telemetryClient.POST("/v2/metrics/cloud/query", {
  body: {
    aggregations: [
      {
        metric: "io.confluent.kafka.server/received_bytes",
        agg: "SUM"
      }
    ],
    filter: {
      op: "AND",
      filters: [
        {
          field: "resource.kafka.id",
          op: "EQ",
          value: clusterId
        }
      ]
    },
    granularity: "PT5M",
    intervals: [`${startTime}/${endTime}`],
    limit: 1000
  }
});
```

**Response Format**:
```typescript
return this.createResponse(
  `Cluster Metrics for ${clusterId} (last 5 minutes):

Active Connections: ${activeConnections}
Request Bytes/sec: ${formatBytes(requestBytes)}
Response Bytes/sec: ${formatBytes(responseBytes)}
Cluster Load: ${clusterLoad}%`,
  false,
  {
    clusterId,
    metrics: metricsData,
    timestamp: new Date().toISOString()
  }
);
```

---

#### Tool 2: `get-topic-metrics`

**Purpose**: Query high-cardinality per-topic metrics

**Handler Location**: `src/confluent/tools/handlers/metrics/get-topic-metrics-handler.ts`

**Input Schema**:
```typescript
const getTopicMetricsArguments = z.object({
  clusterId: z.string().startsWith("lkc-"),
  topicName: z.string()
    .describe("Topic name to query metrics for"),
  metrics: z.array(z.enum([
    "io.confluent.kafka.server/received_bytes",
    "io.confluent.kafka.server/sent_bytes",
    "io.confluent.kafka.server/retained_bytes",
    "io.confluent.kafka.server/received_records",
    "io.confluent.kafka.server/sent_records",
  ])).default([
    "io.confluent.kafka.server/received_bytes",
    "io.confluent.kafka.server/sent_bytes",
    "io.confluent.kafka.server/retained_bytes",
  ]),
  timeRange: z.enum(["1h", "6h", "24h", "7d"]).default("1h"),
});
```

**API Filter**:
```typescript
filter: {
  op: "AND",
  filters: [
    {
      field: "resource.kafka.id",
      op: "EQ",
      value: clusterId
    },
    {
      field: "metric.topic",
      op: "EQ",
      value: topicName
    }
  ]
}
```

---

#### Tool 3: `check-consumer-lag`

**Purpose**: Identify if consumer groups are falling behind

**Handler Location**: `src/confluent/tools/handlers/metrics/check-consumer-lag-handler.ts`

**Input Schema**:
```typescript
const checkConsumerLagArguments = z.object({
  clusterId: z.string().startsWith("lkc-"),
  consumerGroupId: z.string()
    .describe("Consumer group ID to check"),
  warnThreshold: z.number()
    .default(1000)
    .describe("Lag threshold to trigger warning"),
});
```

**API Endpoint** (Kafka REST v3):
```typescript
// Use Kafka REST API for consumer lag
const kafkaRestClient = clientManager.getConfluentCloudKafkaRestClient();

const { data, error } = await kafkaRestClient.GET(
  "/kafka/v3/clusters/{cluster_id}/consumer-groups/{consumer_group_id}/lag-summary",
  {
    params: {
      path: {
        cluster_id: clusterId,
        consumer_group_id: consumerGroupId
      }
    }
  }
);
```

**Response Processing**:
```typescript
const totalLag = data.max_lag_consumer?.total_lag ?? 0;
const isLagging = totalLag > warnThreshold;

return this.createResponse(
  `Consumer Group: ${consumerGroupId}

Status: ${isLagging ? "⚠️  LAGGING" : "✓ Healthy"}
Total Lag: ${totalLag.toLocaleString()} messages
Max Lag Consumer: ${data.max_lag_consumer?.client_id}
Max Lag Topic: ${data.max_lag_consumer?.topic}
Max Lag Partition: ${data.max_lag_consumer?.partition}`,
  isLagging,
  {
    consumerGroupId,
    totalLag,
    isLagging,
    details: data
  }
);
```

---

#### Tool 4: `get-partition-metrics`

**Purpose**: Identify "hot partitions" with partition-level granularity

**Handler Location**: `src/confluent/tools/handlers/metrics/get-partition-metrics-handler.ts`

**Input Schema**:
```typescript
const getPartitionMetricsArguments = z.object({
  clusterId: z.string().startsWith("lkc-"),
  topicName: z.string(),
  partitionId: z.number()
    .optional()
    .describe("Specific partition ID (omit for all partitions)"),
  metric: z.enum([
    "io.confluent.kafka.server/received_bytes",
    "io.confluent.kafka.server/sent_bytes",
  ]).default("io.confluent.kafka.server/received_bytes"),
});
```

**API Request**:
```typescript
filter: {
  op: "AND",
  filters: [
    {
      field: "resource.kafka.id",
      op: "EQ",
      value: clusterId
    },
    {
      field: "metric.topic",
      op: "EQ",
      value: topicName
    },
    // Optionally filter by partition
    ...(partitionId !== undefined ? [{
      field: "metric.partition",
      op: "EQ",
      value: String(partitionId)
    }] : [])
  ]
},
// Group by partition to see distribution
group_by: ["metric.partition"]
```

---

### Phase 2: Infrastructure Discovery Tools

#### Tool 5: `describe-cluster-config`

**Purpose**: Get cluster type (Basic/Standard/Dedicated) and CKU capacity

**Handler Location**: `src/confluent/tools/handlers/clusters/describe-cluster-config-handler.ts`

**Note**: Most of this is already in `list-clusters-handler.ts`, can extract to dedicated tool.

**Enhanced Response**:
```typescript
return this.createResponse(
  `Cluster Configuration: ${clusterName}

Type: ${cluster.spec.config.kind}
CKU Capacity: ${cluster.status.cku ?? cluster.spec.config.cku}
Availability: ${cluster.spec.availability}
Cloud Provider: ${cluster.spec.cloud}
Region: ${cluster.spec.region}
Zones: ${cluster.spec.config.zones?.join(", ")}

Capacity Limits:
  - Max Ingress: ${estimateIngress(ckuCount)} MB/s
  - Max Egress: ${estimateEgress(ckuCount)} MB/s
  - Max Partitions: ${estimatePartitions(ckuCount)}`,
  false,
  { cluster }
);
```

---

### Phase 3: Security & Governance Observability

#### Tool 6: `stream-audit-logs`

**Purpose**: Summarize recent security events

**Handler Location**: `src/confluent/tools/handlers/audit/stream-audit-logs-handler.ts`

**Note**: Audit logs are delivered to a dedicated Kafka topic `confluent-audit-log-events` in the cluster. This tool would consume from that topic.

**Input Schema**:
```typescript
const streamAuditLogsArguments = z.object({
  clusterId: z.string().startsWith("lkc-"),
  eventTypes: z.array(z.enum([
    "authentication",
    "authorization",
    "topic.create",
    "topic.delete",
    "topic.alter",
    "acl.create",
    "acl.delete",
  ])).optional(),
  limit: z.number().default(100),
  lookbackMinutes: z.number().default(60),
});
```

**Implementation**:
```typescript
// Consume from confluent-audit-log-events topic
const consumer = await clientManager.getConsumer(sessionId);
await consumer.subscribe({ topic: "confluent-audit-log-events" });

const messages: AuditEvent[] = [];
await consumer.run({
  eachMessage: async ({ message }) => {
    const event = JSON.parse(message.value.toString());
    if (!eventTypes || eventTypes.includes(event.eventType)) {
      messages.push(event);
    }
  }
});

// Summarize events
return this.createResponse(
  `Audit Log Summary (last ${lookbackMinutes} minutes):

Total Events: ${messages.length}
Authentication Events: ${authCount}
Topic Deletions: ${deleteCount}
Recent Deletions:
${recentDeletions.map(e => `  - ${e.topic} by ${e.user}`).join("\n")}`,
  false,
  { events: messages }
);
```

---

#### Tool 7: `get-schema-registry-status`

**Purpose**: Schema Registry health and compatibility monitoring

**Handler Location**: `src/confluent/tools/handlers/schema/get-schema-registry-status-handler.ts`

**Input Schema**:
```typescript
const getSchemaRegistryStatusArguments = z.object({
  includeCompatibility: z.boolean().default(true),
  checkRecentErrors: z.boolean().default(true),
});
```

**API Calls**:
```typescript
const srClient = clientManager.getConfluentCloudSchemaRegistryRestClient();

// Get all subjects
const { data: subjects } = await srClient.GET("/subjects");

// Get mode (READWRITE, READONLY, etc.)
const { data: mode } = await srClient.GET("/mode");

// Check compatibility settings
const compatibilityChecks = await Promise.all(
  subjects.map(async (subject) => {
    const { data: config } = await srClient.GET(
      "/config/{subject}",
      { params: { path: { subject } } }
    );
    return { subject, compatibility: config?.compatibility };
  })
);

return this.createResponse(
  `Schema Registry Status:

Mode: ${mode.mode}
Total Subjects: ${subjects.length}
Compatibility Errors: ${errorCount}

Compatibility Settings:
${compatibilityChecks.map(c => `  ${c.subject}: ${c.compatibility}`).join("\n")}`,
  false,
  { mode, subjects, compatibilityChecks }
);
```

---

#### Tool 8: `check-client-quotas`

**Purpose**: Monitor API key throttling

**Handler Location**: `src/confluent/tools/handlers/metrics/check-client-quotas-handler.ts`

**Input Schema**:
```typescript
const checkClientQuotasArguments = z.object({
  clusterId: z.string().startsWith("lkc-"),
  principal: z.string()
    .optional()
    .describe("Service account or API key to check (e.g., sa-xxxxx)"),
});
```

**Metrics API Query**:
```typescript
// Query request quota metrics
const { data } = await telemetryClient.POST("/v2/metrics/cloud/query", {
  body: {
    aggregations: [
      {
        metric: "io.confluent.kafka.server/request_count",
        agg: "SUM"
      }
    ],
    filter: {
      op: "AND",
      filters: [
        {
          field: "resource.kafka.id",
          op: "EQ",
          value: clusterId
        },
        ...(principal ? [{
          field: "metric.principal_id",
          op: "EQ",
          value: principal
        }] : [])
      ]
    },
    group_by: ["metric.principal_id"],
    granularity: "PT1M",
    intervals: [`${startTime}/${endTime}`]
  }
});

// Analyze for throttling
const throttledPrincipals = data.data
  .filter(d => d.value > THROTTLE_THRESHOLD)
  .map(d => ({
    principal: d.principal_id,
    requestRate: d.value,
    isThrottled: true
  }));
```

---

## Project Structure

```
src/confluent/tools/handlers/
├── metrics/
│   ├── get-cluster-metrics-handler.ts
│   ├── get-topic-metrics-handler.ts
│   ├── check-consumer-lag-handler.ts
│   ├── get-partition-metrics-handler.ts
│   ├── check-client-quotas-handler.ts
│   └── metrics-helper.ts (shared utilities)
├── clusters/
│   ├── list-clusters-handler.ts (existing)
│   └── describe-cluster-config-handler.ts (new)
├── audit/
│   └── stream-audit-logs-handler.ts
└── schema/
    ├── list-schemas-handler.ts (existing)
    ├── delete-schema-handler.ts (existing)
    └── get-schema-registry-status-handler.ts (new)
```

## Implementation Steps

### Step 1: Add Environment Variables (if needed)

The telemetry endpoint and credentials are already configured. You may want to add defaults:

```typescript
// src/env-schema.ts - already has these!
TELEMETRY_ENDPOINT: "https://api.telemetry.confluent.cloud"
TELEMETRY_API_KEY: falls back to CONFLUENT_CLOUD_API_KEY
TELEMETRY_API_SECRET: falls back to CONFLUENT_CLOUD_API_SECRET
```

### Step 2: Create Shared Metrics Helper

**File**: `src/confluent/tools/handlers/metrics/metrics-helper.ts`

```typescript
import { Client } from "openapi-fetch";
import { paths } from "@src/confluent/openapi-schema.js";

export interface MetricQuery {
  metric: string;
  agg: "SUM" | "AVG" | "MAX" | "MIN" | "COUNT";
}

export interface MetricFilter {
  field: string;
  op: "EQ" | "NE" | "LT" | "GT";
  value: string;
}

export async function queryMetrics(
  client: Client<paths, `${string}/${string}`>,
  dataset: "cloud" | "kafka" | "connect",
  options: {
    aggregations: MetricQuery[];
    filters: MetricFilter[];
    granularity: string;
    startTime: string;
    endTime: string;
    groupBy?: string[];
    limit?: number;
  }
) {
  const { data, error } = await client.POST(
    `/v2/metrics/${dataset}/query` as any,
    {
      body: {
        aggregations: options.aggregations,
        filter: {
          op: "AND",
          filters: options.filters
        },
        granularity: options.granularity,
        intervals: [`${options.startTime}/${options.endTime}`],
        group_by: options.groupBy,
        limit: options.limit ?? 1000
      }
    }
  );

  if (error) {
    throw new Error(`Metrics API error: ${JSON.stringify(error)}`);
  }

  return data;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

export function getTimeRange(range: "1h" | "6h" | "24h" | "7d"): {
  start: string;
  end: string;
} {
  const now = new Date();
  const start = new Date(now);

  const ranges = {
    "1h": 60,
    "6h": 360,
    "24h": 1440,
    "7d": 10080
  };

  start.setMinutes(start.getMinutes() - ranges[range]);

  return {
    start: start.toISOString(),
    end: now.toISOString()
  };
}
```

### Step 3: Register Tools

Update `src/confluent/tools/tool-name.ts`:
```typescript
export enum ToolName {
  // ... existing tools
  GET_CLUSTER_METRICS = "get-cluster-metrics",
  GET_TOPIC_METRICS = "get-topic-metrics",
  CHECK_CONSUMER_LAG = "check-consumer-lag",
  GET_PARTITION_METRICS = "get-partition-metrics",
  DESCRIBE_CLUSTER_CONFIG = "describe-cluster-config",
  STREAM_AUDIT_LOGS = "stream-audit-logs",
  GET_SCHEMA_REGISTRY_STATUS = "get-schema-registry-status",
  CHECK_CLIENT_QUOTAS = "check-client-quotas",
}
```

Update `src/confluent/tools/tool-factory.ts`:
```typescript
import { GetClusterMetricsHandler } from "./handlers/metrics/get-cluster-metrics-handler.js";
// ... other imports

private static handlers: Map<ToolName, ToolHandler> = new Map([
  // ... existing handlers
  [ToolName.GET_CLUSTER_METRICS, new GetClusterMetricsHandler()],
  [ToolName.GET_TOPIC_METRICS, new GetTopicMetricsHandler()],
  [ToolName.CHECK_CONSUMER_LAG, new CheckConsumerLagHandler()],
  [ToolName.GET_PARTITION_METRICS, new GetPartitionMetricsHandler()],
  [ToolName.DESCRIBE_CLUSTER_CONFIG, new DescribeClusterConfigHandler()],
  [ToolName.STREAM_AUDIT_LOGS, new StreamAuditLogsHandler()],
  [ToolName.GET_SCHEMA_REGISTRY_STATUS, new GetSchemaRegistryStatusHandler()],
  [ToolName.CHECK_CLIENT_QUOTAS, new CheckClientQuotasHandler()],
]);
```

### Step 4: Implementation Template

Here's a complete example for `get-cluster-metrics-handler.ts`:

```typescript
import { ClientManager } from "@src/confluent/client-manager.js";
import { CallToolResult } from "@src/confluent/schema.js";
import { BaseToolHandler, ToolConfig } from "@src/confluent/tools/base-tools.js";
import { ToolName } from "@src/confluent/tools/tool-name.js";
import { EnvVar } from "@src/env-schema.js";
import { logger } from "@src/logger.js";
import { z } from "zod";
import { queryMetrics, formatBytes, getTimeRange } from "./metrics-helper.js";

const getClusterMetricsArguments = z.object({
  clusterId: z.string()
    .describe("Kafka cluster ID (e.g., lkc-xxxxx)")
    .startsWith("lkc-"),
  timeRange: z.enum(["1h", "6h", "24h", "7d"])
    .default("1h")
    .describe("Time range for metrics query"),
  granularity: z.enum(["PT1M", "PT5M", "PT15M", "PT1H"])
    .default("PT5M")
    .describe("Time granularity for aggregation"),
});

export class GetClusterMetricsHandler extends BaseToolHandler {
  async handle(
    clientManager: ClientManager,
    toolArguments: Record<string, unknown> | undefined,
  ): Promise<CallToolResult> {
    const { clusterId, timeRange, granularity } =
      getClusterMetricsArguments.parse(toolArguments);

    try {
      const telemetryClient = clientManager.getConfluentCloudTelemetryRestClient();
      const { start, end } = getTimeRange(timeRange);

      const metricsData = await queryMetrics(telemetryClient, "cloud", {
        aggregations: [
          { metric: "io.confluent.kafka.server/active_connection_count", agg: "AVG" },
          { metric: "io.confluent.kafka.server/request_bytes", agg: "SUM" },
          { metric: "io.confluent.kafka.server/response_bytes", agg: "SUM" },
          { metric: "io.confluent.kafka.server/cluster_load_percent", agg: "AVG" },
        ],
        filters: [
          { field: "resource.kafka.id", op: "EQ", value: clusterId }
        ],
        granularity,
        startTime: start,
        endTime: end,
      });

      // Process and format metrics
      const latestMetrics = metricsData.data[metricsData.data.length - 1];

      return this.createResponse(
        `Cluster Metrics for ${clusterId} (${timeRange}):

Active Connections: ${latestMetrics.active_connection_count?.toFixed(0)}
Request Bytes: ${formatBytes(latestMetrics.request_bytes)}
Response Bytes: ${formatBytes(latestMetrics.response_bytes)}
Cluster Load: ${latestMetrics.cluster_load_percent?.toFixed(2)}%

Time Range: ${start} to ${end}
Granularity: ${granularity}`,
        false,
        {
          clusterId,
          metrics: metricsData,
          timeRange,
          timestamp: new Date().toISOString()
        }
      );
    } catch (error) {
      logger.error({ error }, "Error fetching cluster metrics");
      return this.createResponse(
        `Failed to fetch cluster metrics: ${error instanceof Error ? error.message : String(error)}`,
        true,
        { error: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  getToolConfig(): ToolConfig {
    return {
      name: ToolName.GET_CLUSTER_METRICS,
      description: "Fetch real-time telemetry metrics for a Kafka cluster including active connections, throughput, and cluster load",
      inputSchema: getClusterMetricsArguments.shape,
    };
  }

  getRequiredEnvVars(): EnvVar[] {
    return ["TELEMETRY_API_KEY", "TELEMETRY_API_SECRET"];
  }

  isConfluentCloudOnly(): boolean {
    return true;
  }
}
```

## Testing Strategy

### 1. Unit Tests
Test each handler in isolation with mocked API responses.

### 2. Integration Tests
Test against a real Confluent Cloud cluster (use a dev environment).

### 3. Example Test Data

**Metrics API Response**:
```json
{
  "data": [
    {
      "timestamp": "2024-03-15T10:00:00Z",
      "metric.topic": "orders",
      "value": 1024000
    }
  ],
  "meta": {
    "pagination": {
      "total_size": 1
    }
  }
}
```

## API Reference

### Confluent Cloud Metrics API

**Available Metrics** (selection):
- `io.confluent.kafka.server/received_bytes` - Bytes received by brokers
- `io.confluent.kafka.server/sent_bytes` - Bytes sent by brokers
- `io.confluent.kafka.server/retained_bytes` - Data retention size
- `io.confluent.kafka.server/active_connection_count` - Active client connections
- `io.confluent.kafka.server/request_bytes` - Request payload size
- `io.confluent.kafka.server/response_bytes` - Response payload size
- `io.confluent.kafka.server/cluster_load_percent` - Cluster utilization

**Dimensions** (for filtering/grouping):
- `resource.kafka.id` - Cluster ID
- `metric.topic` - Topic name
- `metric.partition` - Partition ID
- `metric.principal_id` - Service account/API key

## Best Practices

1. **Rate Limiting**: Metrics API has rate limits, cache results when appropriate
2. **Time Ranges**: Don't query more than 7 days of data at high granularity
3. **Error Handling**: Always handle missing metrics gracefully
4. **Formatting**: Use human-readable formats for bytes, timestamps
5. **Metadata**: Include query metadata in `_meta` for debugging

## Next Steps

1. Start with `get-cluster-metrics-handler.ts` as the foundation
2. Implement `metrics-helper.ts` for shared functionality
3. Add consumer lag monitoring (high value, commonly requested)
4. Expand to topic-level metrics
5. Add audit log streaming last (most complex)

## Resources

- [Confluent Metrics API Documentation](https://docs.confluent.io/cloud/current/monitoring/metrics-api.html)
- [Kafka REST API v3](https://docs.confluent.io/platform/current/kafka-rest/api.html)
- [Audit Logs](https://docs.confluent.io/cloud/current/security/audit-logs/audit-logs-cloud.html)
